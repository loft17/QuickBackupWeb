// Alterna entre tema oscuro/claro
function toggleTheme() {
    document.body.classList.toggle('dark');
    document.body.classList.toggle('light');
    const themeBtn = document.querySelector('.toggle-theme');
    themeBtn.textContent = document.body.classList.contains('dark') ? '☀️' : '🌙';
  }
  
  // Cargar las unidades disponibles
  fetch('/drives')
    .then(response => response.json())
    .then(data => {
      const sourceSelect = document.getElementById('source');
      const destSelect = document.getElementById('destination');
      data.drives.forEach(drive => {
        const option1 = document.createElement('option');
        option1.value = drive;
        option1.textContent = drive;
        sourceSelect.appendChild(option1);
  
        const option2 = document.createElement('option');
        option2.value = drive;
        option2.textContent = drive;
        destSelect.appendChild(option2);
      });
    })
    .catch(error => console.error('Error al cargar las unidades:', error));
  
  // Manejo del formulario para iniciar el backup
  const backupForm = document.getElementById('backupForm');
  backupForm.addEventListener('submit', function(e) {
    e.preventDefault();
    const source = document.getElementById('source').value;
    const destination = document.getElementById('destination').value;
    if (!source || !destination) {
      alert('Debes seleccionar ambas unidades.');
      return;
    }
    if (source === destination) {
      alert('La unidad de origen y destino no pueden ser la misma.');
      return;
    }
    document.getElementById('progressContainer').style.display = 'flex';
    startBackup(source, destination);
  });
  
  // Función para iniciar el backup y recibir progreso vía SSE
  function startBackup(source, destination) {
    const evtSource = new EventSource('/progress');
    evtSource.onmessage = function(e) {
      const data = JSON.parse(e.data);
      const total = data.totalFiles;
      const copied = data.copiedFiles;
      const percent = total ? Math.floor((copied / total) * 100) : 0;
      const progressFill = document.getElementById('progressFill');
      progressFill.style.width = percent + '%';
      progressFill.textContent = percent + '%';
      document.getElementById('progressText').textContent = `${copied} de ${total} archivos copiados.`;
      if (data.completed) {
        evtSource.close();
        document.getElementById('backupCompleted').style.display = 'block';
      }
    };
  
    fetch('/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination })
    })
    .then(response => response.text())
    .then(message => console.log(message))
    .catch(error => console.error('Error:', error));
  }
  