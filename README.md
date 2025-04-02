# Backup de Unidades - Aplicación de Backup y Verificación

Esta aplicación está diseñada para realizar backups de ficheros (por ejemplo, fotos) desde una unidad de origen a una unidad de destino, con verificación de integridad, manejo de concurrencia dinámico y un diseño moderno y responsivo. Está pensada para entornos con recursos limitados, como una Raspberry Pi, donde se leen archivos desde una tarjeta SD y se copian a un disco HDD.

## Características

- **Copia de Archivos**: Copia los ficheros de la unidad de origen a la unidad de destino manteniendo la estructura de directorios.
- **Verificación de Integridad**: Calcula checksums utilizando streams (usando el módulo `crypto` con algoritmos eficientes como `blake2b512`) para garantizar que los archivos se han copiado correctamente.
- **Concurrencia Dinámica**: Ajusta el número de tareas concurrentes en función de la carga actual del sistema, optimizando el rendimiento en dispositivos como la Raspberry Pi.
- **Persistencia de Metadatos**: Guarda en archivos JSON detalles del backup (fecha, número de archivos, duración, errores y resultados de verificación) en el directorio `backup_logs` para su posterior análisis.
- **Interfaz de Usuario Moderna**: Diseño responsivo, modo oscuro, animaciones y microinteracciones.
- **Indicador de Progreso y Tiempo Estimado**: Se muestra el porcentaje de archivos copiados, así como un cálculo del tiempo restante estimado en función del progreso.
- **Notificaciones Visuales (Toast)**: Muestra mensajes emergentes para notificar eventos importantes (inicio, fin, errores, etc.).
- **Historial de Backups**: Visualiza los backups realizados previamente a través de un historial interactivo en la interfaz.

## Requisitos

- **Node.js** (versión 12 o superior recomendada)
- **NPM** o **Yarn** para gestionar dependencias
- Una **Raspberry Pi** (u otro dispositivo similar) con acceso a:
  - Una tarjeta SD (unidad de origen)
  - Un disco HDD (unidad de destino)

## Instalación

1. Clona el repositorio o copia el código fuente en tu dispositivo.
2. Instala las dependencias ejecutando:
   ```bash
   npm install
   ```

3. Crea un archivo .env en la raíz del proyecto con las siguientes variables (ajústalas según tus necesidades):
   ```env
   PORT=3000
   MEDIA_PATH=/media/joseluis
   LOG_LEVEL=info
   CHECKSUM_ALGO=blake2b512
   ```

## USO
1. Inicia la aplicación:
   ```bash
   npm start
   ```
2. Abre tu navegador en http://localhost:3000 (o la IP de tu Raspberry Pi) para acceder a la interfaz.
3. Selecciona la unidad de origen y la unidad de destino, y pulsa "Iniciar Backup".
   Durante el proceso, se mostrará una barra de progreso, el número de archivos copiados, el tiempo estimado restante y notificaciones visuales.
4. Una vez finalizado el backup, podrás ver el resumen del backup pulsando el botón "Ver Resumen" y consultar el historial de backups realizados.

