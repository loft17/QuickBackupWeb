// index.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const os = require('os'); // Para obtener métricas del sistema
const winston = require('winston');
const checkDiskSpace = require('check-disk-space').default;
const pLimit = require('p-limit'); // Para controlar la concurrencia
const crypto = require('crypto');   // Para calcular checksums

const app = express();
const PORT = process.env.PORT || 3000;
const MEDIA_PATH = process.env.MEDIA_PATH || '/media/joseluis';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
// Algoritmo para checksum: 'blake2b512' es una opción eficiente; también puedes usar 'md5' o 'sha256'
const CHECKSUM_ALGO = process.env.CHECKSUM_ALGO || 'blake2b512';

// Configurar logger con winston
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Servir archivos estáticos de la carpeta "public"
app.use(express.static(path.join(__dirname, 'public')));

// Variables globales para el estado del backup y los clientes SSE
let backupStatus = {
  totalFiles: 0,
  copiedFiles: 0,
  errors: [],
  completed: false,
  destinationFolder: '',
  verification: null,
  integrityVerified: false
};
let backupInProgress = false;
let sseClients = [];

/**
 * Función para ajustar dinámicamente la concurrencia según la carga actual del sistema.
 * Se utiliza la carga promedio de 1 minuto (os.loadavg()[0]).
 * maxConcurrency es el valor máximo deseado.
 */
function getDynamicConcurrency(maxConcurrency) {
  const load = os.loadavg()[0];
  // Si la carga es baja (< 0.5) se usa el máximo; si es alta se reduce hasta usar 1 tarea.
  if (load < 0.5) return maxConcurrency;
  if (load < 1) return Math.max(1, Math.floor(maxConcurrency * (1 - load)));
  return 1;
}

// Función para enviar mensajes SSE a todos los clientes conectados
function sendSseMessage(data) {
  sseClients.forEach(res => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

// Función auxiliar para listar recursivamente todos los ficheros de un directorio
async function listFilesRecursivelyWithSize(dir) {
  let results = [];
  const list = await fs.promises.readdir(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) {
      const subFiles = await listFilesRecursivelyWithSize(filePath);
      results = results.concat(subFiles);
    } else {
      results.push({ filePath, size: stat.size });
    }
  }
  return results;
}

// Función para calcular el checksum de un archivo utilizando streams
async function computeChecksum(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('error', err => reject(err));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Endpoint SSE para enviar actualizaciones de progreso
app.get('/progress', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.flushHeaders();

  // Enviar estado inicial
  res.write(`data: ${JSON.stringify(backupStatus)}\n\n`);
  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

// Endpoint para obtener las unidades disponibles (directorios en MEDIA_PATH)
app.get('/drives', (req, res) => {
  fs.readdir(MEDIA_PATH, (err, items) => {
    if (err) {
      logger.error(`Error al leer MEDIA_PATH: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
    // Filtrar solo los elementos que sean directorios
    const drives = items.filter(item => {
      try {
        const itemPath = path.join(MEDIA_PATH, item);
        return fs.statSync(itemPath).isDirectory();
      } catch (error) {
        return false;
      }
    });
    res.json({ drives });
  });
});

/**
 * Endpoint para iniciar el proceso de backup y verificación de integridad.
 * Se valida que:
 *   - Las unidades de origen y destino sean diferentes.
 *   - No haya ya un backup en curso.
 *   - Se tenga espacio suficiente en el destino.
 *   - Al finalizar, se persisten los metadatos del backup.
 */
app.post('/copy', async (req, res) => {
  const { source, destination } = req.body;
  if (!source || !destination) {
    return res.status(400).send('Debes seleccionar una unidad de origen y otra de destino.');
  }
  if (source === destination) {
    return res.status(400).send('La unidad de origen y destino no pueden ser la misma.');
  }

  // Verificar si ya hay un backup en curso
  if (backupInProgress) {
    return res.status(400).send('Ya hay un proceso de backup en curso.');
  }

  // Rutas completas de origen y destino
  const sourcePath = path.join(MEDIA_PATH, source);
  const destDrivePath = path.join(MEDIA_PATH, destination);

  if (!fs.existsSync(sourcePath) || !fs.existsSync(destDrivePath)) {
    return res.status(400).send('La unidad de origen o destino no existe.');
  }

  // Crear nombre de carpeta con fecha y hora (formato: YYYYMMDD_HHMM)
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  const hh = now.getHours().toString().padStart(2, '0');
  const min = now.getMinutes().toString().padStart(2, '0');
  const folderName = `${yyyy}${mm}${dd}_${hh}${min}`;
  const destPath = path.join(destDrivePath, folderName);

  // Reiniciar estado del backup
  backupStatus = {
    totalFiles: 0,
    copiedFiles: 0,
    errors: [],
    completed: false,
    destinationFolder: destPath,
    verification: null,
    integrityVerified: false
  };
  backupInProgress = true;

  // Listar todos los ficheros en el origen con su tamaño
  let filesToCopy = [];
  try {
    filesToCopy = await listFilesRecursivelyWithSize(sourcePath);
    backupStatus.totalFiles = filesToCopy.length;
    const totalRequired = filesToCopy.reduce((acc, fileObj) => acc + fileObj.size, 0);

    // Revisar el espacio libre en la unidad de destino
    const diskSpace = await checkDiskSpace(destDrivePath);
    if (diskSpace.free < totalRequired) {
      backupInProgress = false; // Liberar el flag si hay error
      return res.status(400).send('No hay espacio suficiente en la unidad de destino.');
    }
    logger.info(`Total de ficheros a copiar: ${backupStatus.totalFiles}, total bytes: ${totalRequired}`);
  } catch (err) {
    backupInProgress = false;
    logger.error(`Error al listar ficheros: ${err.message}`);
    return res.status(500).send(`Error al listar ficheros: ${err.message}`);
  }

  // Registrar la hora de inicio para calcular la duración del backup
  const startTime = Date.now();

  // Iniciar el proceso asíncrono de copia de forma concurrente con concurrencia dinámica
  (async () => {
    // Ajustar concurrencia para la copia según la carga actual (valor máximo deseado: 5)
    const copyConcurrency = getDynamicConcurrency(5);
    const limit = pLimit(copyConcurrency);
    logger.info(`Iniciando copia con concurrencia dinámica: ${copyConcurrency}`);
    const copyTasks = filesToCopy.map(fileObj => limit(async () => {
      const file = fileObj.filePath;
      // Calcular la ruta relativa para conservar la estructura de directorios
      const relativePath = path.relative(sourcePath, file);
      const destFile = path.join(destPath, relativePath);
      try {
        await fse.ensureDir(path.dirname(destFile));
        await fse.copyFile(file, destFile);
        backupStatus.copiedFiles++;
        logger.info(`Copiado: ${file} -> ${destFile}`);
      } catch (err) {
        backupStatus.errors.push({ file, error: err.message });
        logger.warn(`Error al copiar ${file}: ${err.message}`);
      }
      // Enviar actualización de progreso vía SSE
      sendSseMessage(backupStatus);
    }));
    await Promise.all(copyTasks);
    logger.info(`Backup completado. Copiados: ${backupStatus.copiedFiles}, Errores: ${backupStatus.errors.length}`);
    sendSseMessage(backupStatus);

    // Nueva fase: verificación de integridad usando streams y concurrencia dinámica
    logger.info('Iniciando verificación de integridad de archivos');
    backupStatus.verification = { total: filesToCopy.length, verified: 0, mismatches: [] };

    // Ajustar concurrencia para la verificación (valor máximo deseado: 2)
    const verifyConcurrency = getDynamicConcurrency(2);
    const limitVerification = pLimit(verifyConcurrency);
    logger.info(`Iniciando verificación con concurrencia dinámica: ${verifyConcurrency}`);
    const verificationTasks = filesToCopy.map(fileObj => limitVerification(async () => {
      const file = fileObj.filePath;
      const relativePath = path.relative(sourcePath, file);
      const destFile = path.join(destPath, relativePath);
      try {
        // Calcular los checksums de origen y destino de forma concurrente
        const [sourceChecksum, destChecksum] = await Promise.all([
          computeChecksum(file, CHECKSUM_ALGO),
          computeChecksum(destFile, CHECKSUM_ALGO)
        ]);
        if (sourceChecksum !== destChecksum) {
          backupStatus.verification.mismatches.push({ file, sourceChecksum, destChecksum });
          logger.warn(`Error de integridad en ${file}`);
        }
      } catch (err) {
        backupStatus.verification.mismatches.push({ file, error: err.message });
        logger.warn(`Error al verificar ${file}: ${err.message}`);
      }
      backupStatus.verification.verified++;
      sendSseMessage(backupStatus);
    }));
    await Promise.all(verificationTasks);
    backupStatus.integrityVerified = true;
    logger.info(`Verificación completada. Archivos verificados: ${backupStatus.verification.verified}, Mismatches: ${backupStatus.verification.mismatches.length}`);
    sendSseMessage(backupStatus);

    backupStatus.completed = true;
    backupInProgress = false;

    // Calcular la duración total del backup
    const duration = Date.now() - startTime;

    // Persistir metadatos del backup en un archivo JSON
    const backupMetadata = {
      date: new Date().toISOString(),
      source,
      destination,
      destinationFolder: destPath,
      totalFiles: backupStatus.totalFiles,
      copiedFiles: backupStatus.copiedFiles,
      errors: backupStatus.errors,
      verification: backupStatus.verification,
      integrityVerified: backupStatus.integrityVerified,
      durationMs: duration
    };

    const logDir = path.join(__dirname, 'backup_logs');
    await fse.ensureDir(logDir);
    const logFile = path.join(logDir, `backup-${Date.now()}.json`);
    await fs.promises.writeFile(logFile, JSON.stringify(backupMetadata, null, 2));
    logger.info(`Metadatos del backup guardados en ${logFile}`);
  })();

  res.send('Proceso de backup iniciado.');
});

// Endpoint para mostrar el resumen del backup (incluye errores y verificación)
app.get('/summary', (req, res) => {
  const summaryHtml = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Resumen de Backup</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        h1 { text-align: center; }
        .summary { margin-top: 20px; }
        .error-list, .verification-list { margin-top: 20px; color: #b00020; }
        button { padding: 10px 20px; font-size: 1em; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>Resumen de Backup</h1>
      <div class="summary">
        <p>Total de ficheros: ${backupStatus.totalFiles}</p>
        <p>Ficheros copiados: ${backupStatus.copiedFiles}</p>
        <p>Errores en copia: ${backupStatus.errors.length}</p>
        <p>Carpeta destino: ${backupStatus.destinationFolder}</p>
        <p>Integridad verificada: ${backupStatus.integrityVerified ? 'Sí' : 'No'}</p>
      </div>
      ${backupStatus.errors.length > 0 ? `<div class="error-list"><h3>Errores de copia:</h3><ul>${backupStatus.errors.map(e => `<li>${e.file}: ${e.error}</li>`).join('')}</ul></div>` : ''}
      ${backupStatus.verification && backupStatus.verification.mismatches.length > 0 ? `<div class="verification-list"><h3>Errores de verificación:</h3><ul>${backupStatus.verification.mismatches.map(e => `<li>${e.file}: ${e.error || ('Source: ' + e.sourceChecksum + ' / Dest: ' + e.destChecksum)}</li>`).join('')}</ul></div>` : ''}
      <div style="text-align:center; margin-top:20px;">
        <button onclick="window.location.href='/'">Volver</button>
      </div>
    </body>
    </html>
  `;
  res.send(summaryHtml);
});

app.listen(PORT, () => {
  logger.info(`Servidor corriendo en http://localhost:${PORT}`);
});
