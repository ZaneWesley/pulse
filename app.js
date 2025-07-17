const peer = initPeer();
let conn;
let sessionKey;
let droppedFiles = [];

const fileInput = document.getElementById('fileInput');
const peerIdInput = document.getElementById('peerIdInput');
const sendBtn = document.getElementById('sendBtn');
const myIdSpan = document.getElementById('my-id');
const status = document.getElementById('status');
const receiveStatus = document.getElementById('receiveStatus');
const receiveProgress = document.getElementById('receiveProgress');
const dropZone = document.getElementById('dropZone');
const queueList = document.getElementById('queueList');
const copyIdBtn = document.getElementById('copyIdBtn');
const qrContainer = document.getElementById('qrcode');

function generateCustomId(length = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function initPeer() {
  const customId = generateCustomId();
  const peer = new Peer(customId);

  // Show peer ID when ready
  peer.on('open', id => {
    myIdSpan.textContent = id;
    peerIdInput.placeholder = "XXXXXX";

    // Generate QR code on load
    qrContainer.innerHTML = '';
    new QRCode(qrContainer, {
      text: window.location.href.split('?')[0] + '?id=' + id,
      width: 180,
      height: 180,
      colorDark: "#111827",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.H,
    });
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      console.warn(`ID ${customId} is taken, retrying...`);
      initPeer(); // Retry with new ID
    } else {
      console.error('Peer error:', err);
    }
  });

  return peer;
}

// Copy ID to clipboard
copyIdBtn.onclick = () => {
    try {
        navigator.clipboard.writeText(myIdSpan.textContent);
        copyIdBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
        setTimeout(() => (copyIdBtn.innerHTML = '<i class="fa-solid fa-copy"></i>'), 2000);
    } catch (err) {
        showSnackbar('error', `<i class="fa-solid fa-square-exclamation"></i> Failed to copy code`);
    }
};

// Handle drag & drop plus click to select files
dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  for (const file of fileInput.files) addToQueue(file);
  fileInput.value = '';
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const files = e.dataTransfer.files;
  if (files.length) {
    for (const file of files) {
      addToQueue(file);
    }
  }
});

function updateFileCountStatus() {
  const countEl = document.getElementById('fileCountStatus');
  const count = droppedFiles.length;
  countEl.textContent = count === 0
    ? ''
    : count === 1
      ? '1 file in queue'
      : `${count} files in queue`;
}

function addToQueue(file) {
    // skip empty files
    if (file.size === 0) {
    showSnackbar('error',`<i class="fa-solid fa-square-exclamation"></i> Skipping empty file: ${file.name}`);
    return;
  }

  // handle duplicates
  if (droppedFiles.some(f => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) return;

  droppedFiles.push(file);
  const item = document.createElement('div');
  item.className = 'queue-item enter'; // Add enter animation class

  item.innerHTML = `
    <span>${file.name}</span>
    <button aria-label="Remove uploaded file ${file.name}"><i class="fa-regular fa-trash"></i></button>
  `;

  const removeBtn = item.querySelector('button');
  removeBtn.onclick = () => {
    // Animate exit then remove
    item.classList.add('exit');
    item.addEventListener('animationend', () => {
      droppedFiles = droppedFiles.filter(f => !(f.name === file.name && f.size === file.size));
      if (item.parentNode) item.parentNode.removeChild(item); updateFileCountStatus();
    }, { once: true });
  };

  queueList.appendChild(item);
  updateFileCountStatus();

}

// Auto-fill peer ID from URL
if (location.search.includes('id=')) {
  const id = new URLSearchParams(location.search).get('id');
  peerIdInput.value = id;
  document.querySelector('#send-tab').click();
}

// Crypto helpers
async function generateKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function encrypt(buffer, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buffer);
  return { iv, encrypted };
}

async function decrypt(encrypted, iv, key) {
  return await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
}

// Receiving files with progress and resume support
peer.on('connection', incoming => {
  receiveStatus.textContent = `Connected to sender (${incoming.peer})`;

  let currentFile = null;
  let bufferParts = [];
  let iv;
  let receivedBytes = 0;
  let totalBytes = 0;
  let currentFileBox = null;

  incoming.on('data', async data => {
    if (data.type === 'key') {
      sessionKey = await crypto.subtle.importKey("raw", data.key, "AES-GCM", false, ["decrypt"]);
      return;
    }

    if (data === 'EOF') {
      const fullEncrypted = new Uint8Array(bufferParts.reduce((acc, chunk) => acc + chunk.byteLength, 0));
      let offset = 0;
      for (let chunk of bufferParts) {
        fullEncrypted.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }

      try {
        const decrypted = await decrypt(fullEncrypted.buffer, iv, sessionKey);
        const blob = new Blob([decrypted], { type: currentFile.mime });
        const url = URL.createObjectURL(blob);
        const downloadName = currentFile.name;

        currentFileBox.querySelector('.preview-btn').onclick = () => window.open(url);
        currentFileBox.querySelector('.download-btn').onclick = () => downloadFile(url, downloadName);


        receiveStatus.textContent = `Received: ${currentFile.name}`;
        showSnackbar('success', `<i class="fa-solid fa-circle-check"></i> File received: ${currentFile.name}`);

      } catch (e) {
        receiveStatus.textContent = `Failed to decrypt ${currentFile.name}`;
        showSnackbar('error', `<i class="fa-solid fa-square-exclamation"></i> Failed to decrypt: ${currentFile.name}`);
        console.error(e);
      }

      currentFile = null;
      bufferParts = [];
      receivedBytes = 0;
      totalBytes = 0;
      currentFileBox = null;
      return;
    }

    if (data && data.type === 'meta') {
        currentFile = { name: data.name, size: data.size, mime: data.mime };
        iv = new Uint8Array(data.iv);
        bufferParts = [];
        receivedBytes = 0;
        totalBytes = data.size;
        receiveStatus.textContent = `Receiving: ${currentFile.name}`;

        currentFileBox = document.createElement('div');
        currentFileBox.className = 'preview-container enter';

        currentFileBox.innerHTML = `
            <p><strong>${currentFile.name}</strong></p>
            <small class="progress-text">Received 0 / ${formatBytes(totalBytes)}</small>
            <button class="button-primary preview-btn" disabled aria-label="Preview file"><i class="fa-light fa-eye"></i></button>
            <button class="button-primary download-btn" disabled aria-label="Download file"><i class="fa-regular fa-arrow-down-to-line"></i></button>
            <button class="button-primary remove-btn" aria-label="Remove received file ${currentFile.name}"><i class="fa-regular fa-trash"></i></button>
        `;

        receiveProgress.appendChild(currentFileBox);
        document.getElementById('receive-tab').click();

        currentFileBox.querySelector('.remove-btn').onclick = (e) => {
            currentFileBox = e.target.closest('.preview-container');
            currentFileBox.classList.add('exit');
            receiveStatus.textContent = `Removing: ${currentFileBox.querySelector('p strong').textContent}`;
            currentFileBox.addEventListener('animationend', () => {
                if (currentFileBox.parentNode) currentFileBox.parentNode.removeChild(currentFileBox);
            }, { once: true });
        };

        return;
    }


    if (currentFile) {
      bufferParts.push(data);
      receivedBytes += data.byteLength;

      // Update progress text dynamically
      if (currentFileBox) {
        const progressText = currentFileBox.querySelector('.progress-text');
        const lastPreview = receiveProgress.lastElementChild;
        if(lastPreview) {
            const nameText = lastPreview.querySelector('p strong').parentNode; // the <p> containing the filename
            const previewBtn = lastPreview.querySelector('.preview-btn');
            const downloadBtn = lastPreview.querySelector('.download-btn');
            if (nameText) {
            nameText.style.color = (receivedBytes === totalBytes) ? '#fff' : '#b4b4b4';
            }
            if (previewBtn) {
            previewBtn.disabled = (receivedBytes !== totalBytes);
            }
            if (downloadBtn) {
            downloadBtn.disabled = (receivedBytes !== totalBytes);
            }
        }
        if (progressText) {
          progressText.textContent = `Received ${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`;
        }
      }
    }
  });
});

peer.on('disconnected', () => {
  showSnackbar('error','<i class="fa-solid fa-cloud-exclamation"></i> Disconnected from the other device. Attempting reconnect...');
  peer.reconnect();
});


// Sending files with progress and resume support
sendBtn.onclick = async () => {
  const files = [...droppedFiles];
  const targetId = peerIdInput.value.trim();
  if (!files.length) return showSnackbar('error', '<i class="fa-solid fa-square-exclamation"></i> Add files to send');
  if (!targetId) return showSnackbar('error', '<i class="fa-solid fa-triangle-exclamation"></i> Enter Connect Code');
  if (targetId === peer.id) {
    showSnackbar('error', '<i class="fa-solid fa-square-exclamation"></i> Cannot connect to yourself.');
    return;
  }

  sessionKey = await generateKey();
  const rawKey = await crypto.subtle.exportKey("raw", sessionKey);

  conn = peer.connect(targetId);

    conn.on('error', (err) => showSnackbar('error','<i class="fa-solid fa-cloud-exclamation"></i> Connection error: ' + err));
    conn.on('close', () => showSnackbar('error', '<i class="fa-solid fa-cloud-exclamation"></i> Connection closed unexpectedly'));

  conn.on('open', () => {
    conn.send({ type: 'key', key: new Uint8Array(rawKey) });

    let index = 0;

    const sendFile = async (file) => {
      status.textContent = `Encrypting: ${file.name}`;
      const buffer = await file.arrayBuffer();
      const { encrypted, iv } = await encrypt(buffer, sessionKey);

      conn.send({ type: 'meta', name: file.name, size: encrypted.byteLength, mime: file.type, iv: [...iv] });
      status.textContent = `Sending: ${file.name}`;

      const chunkSize = 16 * 1024;
      let sentBytes = 0;

      // Create a subtle progress text under each file in queue
      const fileQueueItems = Array.from(queueList.children);
      const thisFileItem = fileQueueItems.find(item => item.querySelector('span').textContent === file.name);
      if (thisFileItem && !thisFileItem.querySelector('.progress-text')) {
        const progText = document.createElement('small');
        progText.className = 'progress-text';
        progText.textContent = `Sent 0 / ${formatBytes(encrypted.byteLength)}`;
        thisFileItem.appendChild(progText);
      }

      for (let offset = 0; offset < encrypted.byteLength; offset += chunkSize) {
        conn.send(encrypted.slice(offset, offset + chunkSize));
        sentBytes += Math.min(chunkSize, encrypted.byteLength - offset);

        // Update progress text for this file in queue
        if (thisFileItem) {
          const progText = thisFileItem.querySelector('.progress-text');
          if (progText) {
            progText.textContent = `Sent ${formatBytes(sentBytes)} / ${formatBytes(encrypted.byteLength)}`;
          }
        }

        // Wait a tiny bit to avoid flooding
        await new Promise(r => setTimeout(r, 5));
      }

      conn.send('EOF');

      if (++index < files.length) {
        setTimeout(() => sendFile(files[index]), 300);
      } else {
        status.textContent = `All files sent!`;
        showSnackbar('success', '<i class="fa-solid fa-circle-check"></i> All files sent!');
        droppedFiles = [];
        queueList.innerHTML = '';
        updateFileCountStatus();
      }
    };

    sendFile(files[index]);
  });
};

// Helper to format bytes as KB, MB, GB nicely
function formatBytes(bytes, decimals = 1) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Download helper
window.downloadFile = (url, name) => {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
};

// Tab Management

document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-layer').forEach(t => t.classList.remove('active'));
    document.getElementById(tab.id.replace('-tab', '')).classList.add('active');
  };
});

document.getElementById('connectBtn').onclick = () => {
    if(!peerIdInput.value.trim()) return showSnackbar('error', '<i class="fa-solid fa-triangle-exclamation"></i> Enter Connect Code');
    document.getElementById('send-tab').click();
}

// Snackbar helper
function showSnackbar(type, message) {
  const snackbar = document.getElementById("snackbar");
  snackbar.innerHTML = message;
  snackbar.className = ''; // reset classes
  snackbar.classList.add('show', type); // add `success` or `error`

  clearTimeout(snackbar.timeoutId);
  snackbar.timeoutId = setTimeout(() => {
    snackbar.classList.remove('show');
  }, 4000);
}
