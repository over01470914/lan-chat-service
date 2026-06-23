import { categorizeFile, fuzzyMatch, getFilePreviewKind, shortType } from './chat-utils.js';

const state = {
  room: null,
  clientId: localStorage.getItem('lan-chat-client-id') || '',
  role: localStorage.getItem('lan-chat-role') || '',
  socket: null,
  pendingAttachments: [],
  accessStatus: 'approved',
  fileCategory: 'all',
  fileSearch: '',
  activeFile: null,
  longPressTimer: null,
};

const categories = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '圖片' },
  { id: 'video', label: '影片' },
  { id: 'text', label: '文字' },
  { id: 'document', label: '文件' },
  { id: 'archive', label: '壓縮檔' },
  { id: 'other', label: '其他' },
];

const $ = (selector) => document.querySelector(selector);
const landing = $('#landing');
const chat = $('#chat');
const messages = $('#messages');
const messageForm = $('#messageForm');
const messageInput = $('#messageInput');
const fileInput = $('#fileInput');
const attachmentList = $('#attachmentList');
const sendButton = $('#sendButton');
const fileDrawer = $('#fileDrawer');
const drawerBackdrop = $('#drawerBackdrop');
const contextMenu = $('#contextMenu');

$('#createRoomForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const result = await api('/api/rooms', {
    method: 'POST',
    body: { name: form.get('roomName'), hostName: form.get('hostName') },
  });
  state.clientId = result.clientId;
  state.role = 'host';
  localStorage.setItem('lan-chat-client-id', state.clientId);
  localStorage.setItem('lan-chat-role', state.role);
  enterRoom(result.room);
});

$('#joinRoomForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const result = await api(`/api/rooms/${form.get('roomCode')}/join`, {
    method: 'POST',
    body: { name: form.get('clientName'), clientId: state.clientId },
  });
  state.clientId = result.clientId;
  state.role = 'client';
  localStorage.setItem('lan-chat-client-id', state.clientId);
  localStorage.setItem('lan-chat-role', state.role);
  enterRoom(result.room, result.status);
});

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.room || state.accessStatus !== 'approved') return;
  const text = messageInput.value.trim();
  const attachments = [...state.pendingAttachments];
  if (!text && !attachments.length) return;

  messageInput.value = '';
  state.pendingAttachments = [];
  renderAttachments();

  if (text) {
    await api(`/api/rooms/${state.room.code}/messages`, { method: 'POST', body: { clientId: state.clientId, text } });
  }
  for (const attachment of attachments) {
    const form = new FormData();
    form.append('clientId', state.clientId);
    form.append('file', attachment.file);
    const response = await fetch(`/api/rooms/${state.room.code}/files`, { method: 'POST', body: form });
    if (!response.ok) throw new Error(await response.text());
  }
});

fileInput.addEventListener('change', (event) => {
  addAttachments(event.target.files);
  event.target.value = '';
});

for (const dropTarget of [messages, messageForm]) {
  dropTarget.addEventListener('dragover', (event) => {
    if (state.accessStatus !== 'approved') return;
    event.preventDefault();
    chat.classList.add('dragging');
  });
  dropTarget.addEventListener('dragleave', () => chat.classList.remove('dragging'));
  dropTarget.addEventListener('drop', (event) => {
    if (state.accessStatus !== 'approved') return;
    event.preventDefault();
    chat.classList.remove('dragging');
    addAttachments(event.dataTransfer.files);
  });
}

$('#leaveButton').addEventListener('click', () => {
  if (state.socket) state.socket.close();
  state.room = null;
  state.pendingAttachments = [];
  chat.classList.add('hidden');
  landing.classList.remove('hidden');
  hideContextMenu();
});

$('#drawerButton').addEventListener('click', openDrawer);
$('#closeDrawerButton').addEventListener('click', closeDrawer);
drawerBackdrop.addEventListener('click', () => {
  closeDrawer();
  closeSearch();
});
$('#fileSearchInput').addEventListener('input', (event) => {
  state.fileSearch = event.target.value;
  renderFileDrawer();
});
$('#findButton').addEventListener('click', openSearch);
$('#closeSearchButton').addEventListener('click', closeSearch);
$('#globalSearchInput').addEventListener('input', renderSearchResults);
contextMenu.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-menu-action]');
  if (!button || !state.activeFile) return;
  const action = button.dataset.menuAction;
  const file = state.activeFile;
  hideContextMenu();
  if (action === 'download') downloadFile(file);
  if (action === 'delete') await deleteMessage(file.messageId);
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#contextMenu')) hideContextMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideContextMenu();
    closeDrawer();
    closeSearch();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && state.room) {
    event.preventDefault();
    openSearch();
  }
});

function openDrawer() {
  fileDrawer.classList.add('open');
  drawerBackdrop.classList.remove('hidden');
  renderFileDrawer();
}

function closeDrawer() {
  fileDrawer.classList.remove('open');
  if ($('#searchModal').classList.contains('hidden')) drawerBackdrop.classList.add('hidden');
}

function openSearch() {
  $('#searchModal').classList.remove('hidden');
  drawerBackdrop.classList.remove('hidden');
  $('#globalSearchInput').focus();
  renderSearchResults();
}

function closeSearch() {
  $('#searchModal').classList.add('hidden');
  if (!fileDrawer.classList.contains('open')) drawerBackdrop.classList.add('hidden');
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    body: options.body instanceof FormData ? options.body : JSON.stringify(options.body || {}),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function enterRoom(room, status = 'approved') {
  state.room = room;
  state.accessStatus = status;
  landing.classList.add('hidden');
  chat.classList.remove('hidden');
  $('#roomTitle').textContent = room.name;
  $('#roomCode').textContent = room.code;
  updateAccess(room, status);
  renderRoom(room);
  connectSocket();
}

function connectSocket() {
  if (state.socket) state.socket.close();
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  state.socket = new WebSocket(`${protocol}://${location.host}/ws?roomCode=${state.room.code}&clientId=${state.clientId}`);
  state.socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'message') {
      state.room.messages.push(payload.message);
      renderMessages();
      renderFileDrawer();
      renderSearchResults();
    }
    if (payload.type === 'room-updated' || payload.type === 'pending-updated') {
      state.room = payload.room;
      updateAccess(state.room);
      renderRoom(state.room);
    }
    if (payload.type === 'rejected') {
      state.room = payload.room;
      state.pendingAttachments = [];
      updateAccess(state.room, 'rejected');
      renderRoom(state.room);
      renderAttachments();
    }
  });
}

function updateAccess(room, statusHint) {
  const approved = room.approved.some((member) => member.id === state.clientId);
  const pending = room.pending.some((member) => member.id === state.clientId);
  const rejected = statusHint === 'rejected' || (state.role === 'client' && !approved && !pending);
  state.accessStatus = state.role === 'host' || approved ? 'approved' : rejected ? 'rejected' : 'pending';

  const disabled = state.accessStatus !== 'approved';
  messageInput.disabled = disabled;
  fileInput.disabled = disabled;
  sendButton.disabled = disabled;
  $('.fileButton').classList.toggle('disabled', disabled);
  $('#roleText').textContent = state.role === 'host' ? 'Host mode' : state.accessStatus === 'approved' ? 'Client mode' : state.accessStatus === 'rejected' ? '已被 Host 拒絕' : '等待 Host 審核';
  $('#statusText').textContent = state.accessStatus === 'rejected' ? '已拒絕' : state.accessStatus === 'pending' ? '待審核' : '已連線';
}

function addAttachments(fileList) {
  if (!fileList?.length || state.accessStatus !== 'approved') return;
  const additions = [...fileList].map((file) => ({ id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file }));
  state.pendingAttachments.push(...additions);
  renderAttachments();
}

function renderAttachments() {
  if (!state.pendingAttachments.length) {
    attachmentList.innerHTML = '';
    attachmentList.classList.add('hidden');
    return;
  }
  attachmentList.classList.remove('hidden');
  attachmentList.innerHTML = state.pendingAttachments.map((attachment) => {
    const file = attachment.file;
    const preview = file.type.startsWith('image/') ? '<span class="attachmentPreview">image</span>' : '';
    return `<span class="attachmentChip">${preview}<span>${escapeHtml(file.name)}</span><button type="button" data-remove-attachment="${attachment.id}" aria-label="Remove ${escapeHtml(file.name)}">×</button></span>`;
  }).join('');
  attachmentList.querySelectorAll('[data-remove-attachment]').forEach((button) => {
    button.addEventListener('click', () => {
      state.pendingAttachments = state.pendingAttachments.filter((attachment) => attachment.id !== button.dataset.removeAttachment);
      renderAttachments();
    });
  });
}

function renderRoom(room) {
  renderMembers(room);
  renderPending(room);
  renderMessages();
  renderAttachments();
  renderFileDrawer();
  renderSearchResults();
}

function renderMembers(room) {
  $('#memberList').innerHTML = room.approved.map((member) => `<div class="person"><span>${escapeHtml(member.name)}</span><small>${member.role}</small></div>`).join('');
}

function renderPending(room) {
  const box = $('#pendingBox');
  const list = $('#pendingList');
  const isHost = state.role === 'host';
  box.classList.toggle('hidden', !isHost);
  if (!isHost) return;
  list.innerHTML = room.pending.length ? room.pending.map((member) => `
    <div class="pendingRow">
      <span>${escapeHtml(member.name)}</span>
      <div class="pendingActions">
        <button data-approve="${member.id}">允許</button>
        <button class="danger" data-reject="${member.id}">拒絕</button>
      </div>
    </div>`).join('') : '<p class="subtle">沒有待審核成員</p>';
  list.querySelectorAll('[data-approve]').forEach((button) => {
    button.addEventListener('click', async () => {
      const result = await api(`/api/rooms/${state.room.code}/approve`, { method: 'POST', body: { hostId: state.clientId, clientId: button.dataset.approve } });
      state.room = result.room;
      renderRoom(state.room);
    });
  });
  list.querySelectorAll('[data-reject]').forEach((button) => {
    button.addEventListener('click', async () => {
      const result = await api(`/api/rooms/${state.room.code}/reject`, { method: 'POST', body: { hostId: state.clientId, clientId: button.dataset.reject } });
      state.room = result.room;
      renderRoom(state.room);
    });
  });
}

function renderMessages() {
  if (!state.room) return;
  messages.innerHTML = state.room.messages.map((message) => {
    const mine = message.clientId === state.clientId ? ' mine' : '';
    const body = message.type === 'file' ? renderFile(message) : `<div>${linkify(escapeHtml(message.text))}</div>`;
    return `<article id="message-${message.id}" class="message${mine}" data-message-id="${message.id}"><div class="meta"><span>${escapeHtml(message.authorName)}</span><span>${new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>${body}</article>`;
  }).join('');
  bindFileInteractions(messages);
  messages.scrollTop = messages.scrollHeight;
}

function renderFile(message) {
  const file = toFileItem(message);
  const preview = renderFilePreview(file, 'message');
  return `<div class="fileMessage"><a class="fileCard" href="${file.url}" download data-file-message-id="${file.messageId}">
    <span class="fileIcon">${file.shortType}</span>
    <span><span class="fileName">${escapeHtml(file.name)}</span><span class="fileMeta">${file.categoryLabel}</span></span>
    <span class="fileHint">右鍵或長按</span>
    ${preview}
  </a></div>`;
}

function renderFilePreview(file, scope = 'drawer') {
  const kind = getFilePreviewKind(file.name, file.mimeType);
  if (kind === 'image') return `<img src="${file.url}" alt="${escapeHtml(file.name)}" loading="lazy" />`;
  if (kind === 'video') return `<video src="${file.url}" preload="metadata" controls ${scope === 'drawer' ? '' : 'muted'} aria-label="${escapeHtml(file.name)}"></video>`;
  return '';
}

function renderCategoryTabs() {
  const files = getFileItems();
  $('#fileCategoryTabs').innerHTML = categories.map((category) => {
    const count = category.id === 'all' ? files.length : files.filter((file) => file.category === category.id).length;
    const active = state.fileCategory === category.id ? ' active' : '';
    return `<button type="button" class="${active.trim()}" data-file-category="${category.id}">${category.label} ${count}</button>`;
  }).join('');
  $('#fileCategoryTabs').querySelectorAll('[data-file-category]').forEach((button) => {
    button.addEventListener('click', () => {
      state.fileCategory = button.dataset.fileCategory;
      renderFileDrawer();
    });
  });
}

function renderFileDrawer() {
  if (!state.room) return;
  renderCategoryTabs();
  const files = getFilteredFileItems();
  const list = $('#fileList');
  if (!files.length) {
    list.innerHTML = '<div class="emptyState">這個分類目前沒有檔案。可用上方欄位依檔名模糊搜尋。</div>';
    return;
  }
  list.innerHTML = files.map((file) => `
    <article class="drawerFile" data-file-message-id="${file.messageId}">
      <span class="fileIcon">${file.shortType}</span>
      <div><div class="fileName">${escapeHtml(file.name)}</div><div class="fileMeta">${file.categoryLabel} / ${escapeHtml(file.authorName)} / ${new Date(file.createdAt).toLocaleDateString()}</div></div>
      ${renderFilePreview(file)}
    </article>
  `).join('');
  bindFileInteractions(list);
}

function renderSearchResults() {
  if (!state.room || $('#searchModal').classList.contains('hidden')) return;
  const query = $('#globalSearchInput').value.trim();
  const results = searchMessages(query);
  const container = $('#searchResults');
  if (!query) {
    container.innerHTML = '<div class="emptyState">輸入關鍵字後，會搜尋訊息文字、檔名與作者。</div>';
    return;
  }
  if (!results.length) {
    container.innerHTML = '<div class="emptyState">找不到符合的訊息。</div>';
    return;
  }
  container.innerHTML = results.map((result) => `
    <button type="button" class="searchResult" data-jump-message="${result.id}">
      <strong>${escapeHtml(result.title)}</strong>
      <div class="resultSnippet">${escapeHtml(result.snippet)}</div>
    </button>
  `).join('');
  container.querySelectorAll('[data-jump-message]').forEach((button) => {
    button.addEventListener('click', () => jumpToMessage(button.dataset.jumpMessage));
  });
}

function bindFileInteractions(root) {
  root.querySelectorAll('[data-file-message-id]').forEach((element) => {
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showFileMenu(element.dataset.fileMessageId, event.clientX, event.clientY);
    });
    element.addEventListener('touchstart', (event) => {
      clearTimeout(state.longPressTimer);
      const touch = event.touches[0];
      state.longPressTimer = setTimeout(() => showFileMenu(element.dataset.fileMessageId, touch.clientX, touch.clientY), 620);
    }, { passive: true });
    element.addEventListener('touchend', () => clearTimeout(state.longPressTimer));
    element.addEventListener('touchmove', () => clearTimeout(state.longPressTimer));
  });
}

function showFileMenu(messageId, x, y) {
  const file = getFileItems().find((item) => item.messageId === messageId);
  if (!file) return;
  state.activeFile = file;
  contextMenu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 110)}px`;
  contextMenu.classList.remove('hidden');
}

function hideContextMenu() {
  contextMenu.classList.add('hidden');
  state.activeFile = null;
}

function downloadFile(file) {
  const link = document.createElement('a');
  link.href = file.url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function deleteMessage(messageId) {
  if (!messageId || !state.room) return;
  if (!confirm('刪除這個檔案訊息？這會從房間紀錄移除。')) return;
  const result = await api(`/api/rooms/${state.room.code}/messages/${messageId}`, {
    method: 'DELETE',
    body: { clientId: state.clientId },
  });
  state.room = result.room;
  renderRoom(state.room);
}

function jumpToMessage(messageId) {
  closeSearch();
  const element = document.getElementById(`message-${messageId}`);
  if (!element) return;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element.classList.add('highlight');
  setTimeout(() => element.classList.remove('highlight'), 1400);
}

function getFileItems() {
  if (!state.room) return [];
  return state.room.messages.filter((message) => message.type === 'file' && message.file).map(toFileItem).reverse();
}

function getFilteredFileItems() {
  return getFileItems().filter((file) => {
    const categoryOk = state.fileCategory === 'all' || file.category === state.fileCategory;
    const searchOk = !state.fileSearch.trim() || fuzzyMatch(file.name, state.fileSearch.trim());
    return categoryOk && searchOk;
  });
}

function toFileItem(message) {
  const file = message.file;
  const category = categorizeFile(file.name, file.mimeType);
  const categoryLabel = categories.find((item) => item.id === category)?.label || '其他';
  return {
    messageId: message.id,
    clientId: message.clientId,
    authorName: message.authorName,
    createdAt: message.createdAt,
    name: file.name,
    url: file.url,
    mimeType: file.mimeType || '',
    category,
    categoryLabel,
    shortType: shortType(file.name, category),
  };
}


function searchMessages(query) {
  if (!query) return [];
  return state.room.messages.filter((message) => {
    const haystack = message.type === 'file'
      ? `${message.file?.name || ''} ${message.authorName || ''} ${message.file?.mimeType || ''}`
      : `${message.text || ''} ${message.authorName || ''}`;
    return fuzzyMatch(haystack, query);
  }).map((message) => ({
    id: message.id,
    title: message.type === 'file' ? `檔案: ${message.file.name}` : `${message.authorName} 的訊息`,
    snippet: message.type === 'file' ? `${message.file.mimeType || 'file'} / ${new Date(message.createdAt).toLocaleString()}` : message.text,
  })).reverse();
}


function linkify(text) {
  return text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}
