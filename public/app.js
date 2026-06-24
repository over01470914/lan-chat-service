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
  invite: null,
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
const RECENT_ROOMS_KEY = 'lan-chat-recent-rooms';

renderRecentRooms();
prefillRoomCodeFromUrl();
let joinedAt = null;
let toastTimer = null;

$('#createRoomForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const result = await api('/api/rooms', {
    method: 'POST',
    body: { name: form.get('roomName'), hostName: form.get('hostName'), autoApprove: form.get('autoApprove') === 'on' },
  });
  state.clientId = result.clientId;
  state.invite = result.invite || null;
  state.role = 'host';
  localStorage.setItem('lan-chat-client-id', state.clientId);
  localStorage.setItem('lan-chat-role', state.role);
  enterRoom(result.room);
});

$('#clearRecentRoomsButton').addEventListener('click', () => {
  localStorage.removeItem(RECENT_ROOMS_KEY);
  renderRecentRooms();
});

$('#joinRoomForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const result = await api(`/api/rooms/${form.get('roomCode')}/join`, {
    method: 'POST',
    body: { name: form.get('clientName'), clientId: state.clientId, inviteToken: inviteTokenFromUrl() },
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
  state.invite = null;
  chat.classList.add('hidden');
  landing.classList.remove('hidden');
  hideContextMenu();
});

$('#drawerButton').addEventListener('click', openDrawer);
$('#drawerShortcutButton')?.addEventListener('click', openDrawer);
$('#closeDrawerButton').addEventListener('click', closeDrawer);
$('#copyRoomCodeButton')?.addEventListener('click', () => copyRoomCode(false));
$('#copyPlainCodeButton')?.addEventListener('click', () => copyRoomCode(false));
$('#copyInviteButton')?.addEventListener('click', () => copyRoomCode(true));
$('#settingsButton')?.addEventListener('click', () => openUtilityPanel('settings'));
$('#networkButton')?.addEventListener('click', () => openUtilityPanel('network'));
$('#reviewPanelButton')?.addEventListener('click', () => openUtilityPanel('review'));
$('#sharePanelButton')?.addEventListener('click', () => openUtilityPanel('share'));
$('#mobileShareButton')?.addEventListener('click', openMobileShare);
$('#closeUtilityButton')?.addEventListener('click', closeUtilityPanel);
$('#utilityBody')?.addEventListener('click', async (event) => {
  const rotate = event.target.closest('[data-rotate-invite]');
  if (rotate) {
    await rotateInviteToken();
    openUtilityPanel('share');
    return;
  }
  const button = event.target.closest('[data-copy-value]');
  if (!button) return;
  copyText(button.dataset.copyValue || '', button.dataset.copyLabel || '已複製');
});
drawerBackdrop.addEventListener('click', () => {
  closeDrawer();
  closeSearch();
  closeUtilityPanel();
});
$('#fileSearchInput').addEventListener('input', (event) => {
  state.fileSearch = event.target.value;
  renderFileDrawer();
});
$('#findButton').addEventListener('click', openSearch);
$('#closeSearchButton').addEventListener('click', closeSearch);
$('#globalSearchInput').addEventListener('input', renderSearchResults);
$('#autoApproveToggle').addEventListener('change', async (event) => {
  if (!state.room || state.role !== 'host') return;
  event.currentTarget.disabled = true;
  try {
    const result = await api(`/api/rooms/${state.room.code}/settings`, {
      method: 'POST',
      body: { hostId: state.clientId, autoApprove: event.currentTarget.checked },
    });
    state.room = result.room;
    renderRoom(state.room);
  } finally {
    event.currentTarget.disabled = false;
  }
});
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
    closeUtilityPanel();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && state.room) {
    event.preventDefault();
    openSearch();
  }
});

function openDrawer() {
  fileDrawer.classList.add('open');
  syncBackdrop();
  renderFileDrawer();
}

function closeDrawer() {
  fileDrawer.classList.remove('open');
  syncBackdrop();
}

function openSearch() {
  $('#searchModal').classList.remove('hidden');
  syncBackdrop();
  $('#globalSearchInput').focus();
  renderSearchResults();
}

function closeSearch() {
  $('#searchModal').classList.add('hidden');
  syncBackdrop();
}

function openUtilityPanel(kind) {
  if (!state.room) return;
  const modal = $('#utilityModal');
  $('#utilityKicker').textContent = kind === 'network' ? 'Network' : kind === 'settings' ? 'Settings' : kind === 'share' ? 'Invite' : 'Review';
  $('#utilityTitle').textContent = kind === 'network' ? '網路資訊' : kind === 'settings' ? '房間設定' : kind === 'share' ? '移動端分享' : '成員與審核';
  $('#utilityBody').innerHTML = renderUtilityBody(kind);
  modal.classList.remove('hidden');
  syncBackdrop();
}

function closeUtilityPanel() {
  $('#utilityModal')?.classList.add('hidden');
  syncBackdrop();
}

function syncBackdrop() {
  const searchOpen = !$('#searchModal').classList.contains('hidden');
  const utilityOpen = !$('#utilityModal')?.classList.contains('hidden');
  const drawerOpen = fileDrawer.classList.contains('open');
  drawerBackdrop.classList.toggle('hidden', !(searchOpen || utilityOpen || drawerOpen));
}

async function api(url, options = {}) {
  const hasBody = Object.prototype.hasOwnProperty.call(options, 'body');
  const init = { ...options };
  if (hasBody) {
    init.headers = options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' };
    init.body = options.body instanceof FormData ? options.body : JSON.stringify(options.body || {});
  } else {
    delete init.body;
  }
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function enterRoom(room, status = 'approved') {
  state.room = room;
  joinedAt = new Date();
  state.accessStatus = deriveAccessStatus(room, status);
  rememberRoom(room, state.accessStatus);
  landing.classList.add('hidden');
  chat.classList.remove('hidden');
  $('#roomTitle').textContent = room.name;
  $('#roomCode').textContent = room.code;
  $('#mobileRoomCode').textContent = room.code;
  updateAccess(room, status);
  renderRoom(room);
  renderSessionCard();
  refreshHostInvite();
  connectSocket();
}

function loadRecentRooms() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_ROOMS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rememberRoom(room, status = 'approved') {
  if (!room?.code || !state.clientId) return;
  const item = {
    code: room.code,
    name: room.name,
    role: state.role || 'client',
    clientId: state.clientId,
    status,
    origin: location.origin,
    lastOpenedAt: new Date().toISOString(),
  };
  const next = loadRecentRooms().filter((existing) => !(existing.origin === item.origin && existing.code === item.code && existing.clientId === item.clientId));
  next.unshift(item);
  localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(next.slice(0, 12)));
  renderRecentRooms();
}

function forgetRecentRoom(index) {
  const next = loadRecentRooms();
  next.splice(index, 1);
  localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(next));
  renderRecentRooms();
}

function renderRecentRooms() {
  const section = $('#recentRooms');
  const list = $('#recentRoomsList');
  if (!section || !list) return;
  const rooms = loadRecentRooms();
  section.classList.toggle('hidden', rooms.length === 0);
  if (!rooms.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = rooms.map((room, index) => `
    <article class="recentRoomCard">
      <button type="button" class="recentRoomOpen" data-open-recent="${index}">
        <span class="recentRoomCode">${escapeHtml(room.code)}</span>
        <span><strong>${escapeHtml(room.name || 'LAN Room')}</strong><small>${escapeHtml(room.role || 'client')} / ${new Date(room.lastOpenedAt).toLocaleString()}</small></span>
      </button>
      <button type="button" class="ghost small" data-forget-recent="${index}">移除</button>
    </article>
  `).join('');
  list.querySelectorAll('[data-open-recent]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = loadRecentRooms()[Number(button.dataset.openRecent)];
      if (!item) return;
      try {
        state.clientId = item.clientId;
        state.role = item.role;
        localStorage.setItem('lan-chat-client-id', state.clientId);
        localStorage.setItem('lan-chat-role', state.role);
        const result = item.role === 'host'
          ? await api(`/api/rooms/${item.code}`)
          : await api(`/api/rooms/${item.code}/join`, { method: 'POST', body: { name: item.name || 'Client', clientId: item.clientId, inviteToken: inviteTokenFromUrl() } });
        enterRoom(result.room, result.status || item.status || 'approved');
      } catch (error) {
        console.warn('recent room reopen failed', error);
        alert('這個 Room 已不存在、目前無法連線，或你的舊身份已失效。');
      }
    });
  });
  list.querySelectorAll('[data-forget-recent]').forEach((button) => {
    button.addEventListener('click', () => forgetRecentRoom(Number(button.dataset.forgetRecent)));
  });
}

function deriveAccessStatus(room, statusHint) {
  const approved = room.approved.some((member) => member.id === state.clientId);
  const isHost = room.approved.some((member) => member.id === state.clientId && member.role === 'host');
  const pending = room.pending.some((member) => member.id === state.clientId);
  if (isHost || approved) return 'approved';
  if (statusHint === 'rejected' || (!pending && statusHint !== 'pending')) return 'rejected';
  return 'pending';
}

function connectSocket() {
  if (state.socket) state.socket.close();
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  updateSocketStatus('連線中');
  state.socket = new WebSocket(`${protocol}://${location.host}/ws?roomCode=${state.room.code}&clientId=${state.clientId}`);
  state.socket.addEventListener('open', () => updateSocketStatus('WS LIVE'));
  state.socket.addEventListener('close', () => updateSocketStatus('離線'));
  state.socket.addEventListener('error', () => updateSocketStatus('連線錯誤'));
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
      rememberRoom(state.room, state.accessStatus);
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
  state.accessStatus = deriveAccessStatus(room, statusHint);

  const disabled = state.accessStatus !== 'approved';
  messageInput.disabled = disabled;
  fileInput.disabled = disabled;
  sendButton.disabled = disabled;
  messageInput.placeholder = disabled ? '等待 Host 審核後才能輸入訊息' : '輸入訊息或貼上連結';
  $('.fileButton').classList.toggle('disabled', disabled);
  chat.classList.toggle('access-pending', state.accessStatus === 'pending');
  chat.classList.toggle('access-rejected', state.accessStatus === 'rejected');

  const autoApproveControl = $('#autoApproveControl');
  const autoApproveToggle = $('#autoApproveToggle');
  const isHost = room.approved.some((member) => member.id === state.clientId && member.role === 'host');
  autoApproveControl.classList.toggle('hidden', !isHost);
  autoApproveToggle.checked = Boolean(room.autoApprove);
  autoApproveToggle.disabled = !isHost;

  const notice = $('#accessNotice');
  const noticeTitle = $('#accessNoticeTitle');
  const noticeText = $('#accessNoticeText');
  notice.classList.toggle('hidden', state.accessStatus === 'approved');
  if (state.accessStatus === 'pending') {
    noticeTitle.textContent = '等待 Host 審核中';
    noticeText.textContent = '你目前還不能打字或上傳檔案。請等 Host 批准，或請 Host 開啟 Auto approve。';
  } else if (state.accessStatus === 'rejected') {
    noticeTitle.textContent = 'Host 已拒絕此身份';
    noticeText.textContent = '這個 clientId 不能在此 Room 發訊息或上傳檔案，請回首頁重新申請或聯絡 Host。';
  }

  $('#roleText').textContent = isHost ? `Host mode / Auto approve ${room.autoApprove ? 'ON' : 'OFF'}` : state.accessStatus === 'approved' ? 'Client mode' : state.accessStatus === 'rejected' ? '已被 Host 拒絕' : '等待 Host 審核';
  $('#statusText').textContent = state.accessStatus === 'rejected' ? '已拒絕' : state.accessStatus === 'pending' ? '待審核中，暫不可發言' : '已連線';
  renderSessionCard();
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
  renderSessionCard();
}

function renderMembers(room) {
  const approved = room.approved || [];
  const host = approved.find((member) => member.role === 'host') || approved[0];
  $('#memberCountHint').textContent = `${approved.length} / 24`;
  $('#hostHint').textContent = host ? `${host.name} ${host.role === 'host' ? '(Host)' : ''}` : '未指定';
  $('#memberList').innerHTML = approved.map((member) => `<div class="person" data-initial="${escapeHtml((member.name || '?').slice(0, 1))}"><span>${escapeHtml(member.name)}</span><small>${escapeHtml(member.role)}</small></div>`).join('');
}

function renderPending(room) {
  const box = $('#pendingBox');
  const list = $('#pendingList');
  const isHost = state.role === 'host';
  const pendingCount = room.pending?.length || 0;
  $('#pendingCountHint').textContent = pendingCount;
  $('#topPendingHint').textContent = pendingCount;
  box.classList.toggle('hidden', !isHost);
  if (!isHost) return;
  list.innerHTML = pendingCount ? room.pending.map((member) => `
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
  const allFiles = getFileItems();
  $('#fileVaultSummary').textContent = `共 ${allFiles.length} 個檔案`;
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
      <span class="fileStatus">已核准</span>
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


function prefillRoomCodeFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get('room');
  const token = params.get('token');
  const input = document.querySelector('[name="roomCode"]');
  if (code && input) input.value = code.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
  if (token) localStorage.setItem('lan-chat-invite-token', token.slice(0, 64));
}

function inviteTokenFromUrl() {
  const params = new URLSearchParams(location.search);
  return params.get('token') || localStorage.getItem('lan-chat-invite-token') || '';
}

function inviteLink() {
  if (state.invite?.inviteUrl) return state.invite.inviteUrl;
  if (!state.room?.code) return location.origin;
  const url = new URL(location.origin);
  url.searchParams.set('room', state.room.code);
  if (state.invite?.inviteToken) url.searchParams.set('token', state.invite.inviteToken);
  return url.toString();
}

function cliJoinCommand() {
  if (state.invite?.cliCommand) return state.invite.cliCommand;
  if (!state.room?.code) return '';
  return `lan-chat join --server ${location.origin} --room ${state.room.code}${state.invite?.inviteToken ? ` --token ${state.invite.inviteToken}` : ''} --name Mobile`;
}

function sshTunnelHint() {
  return state.invite?.sshTunnelHint || `ssh -L 4301:127.0.0.1:4301 user@host`;
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  showToast(label);
}

function copyRoomCode(withLink) {
  if (!state.room?.code) return;
  const text = withLink ? inviteLink() : state.room.code;
  copyText(text, withLink ? '已複製邀請連結' : '已複製 Room Code');
}

function showToast(text) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 1800);
}

function renderSessionCard() {
  if (!state.room) return;
  const isHost = state.role === 'host';
  const title = $('#sessionTitle');
  const text = $('#sessionText');
  const role = $('#sessionRoleMeta');
  const icon = $('#sessionIcon');
  const card = $('#sessionCard');
  if (!title || !text || !role || !icon || !card) return;
  card.classList.remove('sessionLive', 'sessionPending', 'sessionRejected');
  if (state.accessStatus === 'pending') {
    card.classList.add('sessionPending');
    icon.textContent = '…';
    title.textContent = '等待 Host 核准加入';
    text.textContent = '你的請求已送出。核准後即可存取聊天室、檔案庫與上傳功能。';
  } else if (state.accessStatus === 'rejected') {
    card.classList.add('sessionRejected');
    icon.textContent = '×';
    title.textContent = '此身份已被拒絕';
    text.textContent = 'Host 拒絕了這個 clientId。請回首頁重新申請或請 Host 重新核准。';
  } else {
    card.classList.add('sessionLive');
    icon.textContent = isHost ? '⌁' : '✓';
    title.textContent = isHost ? 'Host control plane 已就緒' : '你已進入 Room';
    text.textContent = isHost ? '可審核成員、分享 Room Code、切換 Auto approve，或打開檔案庫查看傳輸狀態。' : '你可以傳訊息、上傳檔案，並從檔案庫搜尋已核准的資源。';
  }
  role.textContent = isHost ? 'Host' : state.accessStatus === 'approved' ? 'Client' : state.accessStatus;
  role.title = `加入時間 ${(joinedAt || new Date()).toLocaleTimeString()}`;
  renderInviteSummary();
}

function updateSocketStatus(text) {
  const meta = $('#socketStatusMeta');
  if (meta) meta.textContent = text;
}

async function refreshHostInvite() {
  if (!state.room) return;
  if (state.role !== 'host') {
    renderInviteSummary();
    return;
  }
  if (state.invite?.roomCode === state.room.code) {
    renderInviteSummary();
    return;
  }
  try {
    const result = await api(`/api/rooms/${state.room.code}/invite?hostId=${encodeURIComponent(state.clientId)}`);
    state.invite = result.invite;
    renderInviteSummary();
  } catch (error) {
    console.warn('invite refresh failed', error);
    renderInviteSummary();
  }
}

async function rotateInviteToken() {
  if (!state.room || state.role !== 'host') return;
  const result = await api(`/api/rooms/${state.room.code}/invite/rotate`, { method: 'POST', body: { hostId: state.clientId } });
  state.invite = result.invite;
  renderInviteSummary();
  showToast('已更新邀請 token');
}

function renderInviteSummary() {
  const target = $('#mobileInviteUrl');
  const mobileButton = $('#mobileShareButton');
  const inviteButton = $('#copyInviteButton');
  const isHost = state.role === 'host';
  if (target) {
    if (isHost && state.invite?.inviteUrl) target.textContent = state.invite.inviteUrl;
    else if (isHost) target.textContent = 'URL+Token 生成中';
    else target.textContent = inviteTokenFromUrl() ? 'Invite token 已套用' : 'Client mode / 已連線';
  }
  if (mobileButton) {
    mobileButton.textContent = isHost ? '分享' : '房碼';
    mobileButton.disabled = false;
  }
  if (inviteButton) {
    inviteButton.disabled = !isHost || !state.invite?.inviteUrl;
    inviteButton.textContent = isHost ? '複製 URL+Token' : 'Host 分享專用';
  }
}

function openMobileShare() {
  if (state.role === 'host') openUtilityPanel('share');
  else copyRoomCode(false);
}

function renderUtilityBody(kind) {
  const room = state.room;
  const fileCount = getFileItems().length;
  const memberCount = room.approved?.length || 0;
  const pendingCount = room.pending?.length || 0;
  if (kind === 'share') {
    if (state.role !== 'host') {
      return `<div class="utilityGrid">
        <div class="utilityMetric wide"><small>Room Code</small><strong>${escapeHtml(room.code)}</strong><button type="button" class="metricCopy" data-copy-value="${escapeHtml(room.code)}" data-copy-label="已複製 Room Code">Copy</button></div>
      </div><p class="utilityNote">你目前是 Client。只有 Host 會顯示 URL+Token 分享與重新生成 token；Client 只可複製 Room Code。</p>`;
    }
    const ready = Boolean(state.invite?.inviteUrl);
    const url = ready ? inviteLink() : '生成中';
    const token = state.invite?.inviteToken || '生成中';
    return `<div class="utilityGrid">
      <div class="utilityMetric wide"><small>Mobile invite URL</small><strong>${escapeHtml(url)}</strong><button type="button" class="metricCopy" ${ready ? `data-copy-value="${escapeHtml(url)}"` : 'disabled'} data-copy-label="已複製 mobile invite URL">Copy</button></div>
      <div class="utilityMetric"><small>Room Token</small><strong>${escapeHtml(token)}</strong><button type="button" class="metricCopy" ${ready ? `data-copy-value="${escapeHtml(state.invite.inviteToken)}"` : 'disabled'} data-copy-label="已複製 token">Copy</button></div>
      <div class="utilityMetric wide"><small>CLI / SSH handoff</small><strong>${escapeHtml(ready ? cliJoinCommand() : '生成中')}</strong><button type="button" class="metricCopy" ${ready ? `data-copy-value="${escapeHtml(cliJoinCommand())}"` : 'disabled'} data-copy-label="已複製 CLI join command">Copy</button></div>
      <div class="utilityMetric wide"><small>SSH tunnel hint</small><strong>${escapeHtml(sshTunnelHint())}</strong><button type="button" class="metricCopy" data-copy-value="${escapeHtml(sshTunnelHint())}" data-copy-label="已複製 SSH tunnel hint">Copy</button></div>
    </div><p class="utilityNote">把 Mobile invite URL 傳給手機即可帶 token 加入並自動核准。Token 只允許加入，不含 Host 權限；需要失效舊連結時可重新生成。</p><button type="button" class="ghost" data-rotate-invite>重新生成 token</button>`;
  }
  if (kind === 'network') {
    return `<div class="utilityGrid">
      <div class="utilityMetric"><small>Origin</small><strong>${escapeHtml(location.origin)}</strong><button type="button" class="metricCopy" data-copy-value="${escapeHtml(location.origin)}" data-copy-label="已複製 Origin">Copy</button></div>
      <div class="utilityMetric"><small>WebSocket</small><strong>${escapeHtml($('#socketStatusMeta')?.textContent || '未知')}</strong></div>
      <div class="utilityMetric"><small>Room Code</small><strong>${escapeHtml(room.code)}</strong><button type="button" class="metricCopy" data-copy-value="${escapeHtml(room.code)}" data-copy-label="已複製 Room Code">Copy</button></div>
      <div class="utilityMetric"><small>Peer / Pending</small><strong>${memberCount} / ${pendingCount}</strong></div>
    </div><p class="utilityNote">這裡對應概念圖的網路資訊入口：用來快速確認 LAN origin、WebSocket 狀態、Room Code 與 peer 數量。</p>`;
  }
  if (kind === 'settings') {
    return `<div class="utilityGrid">
      <div class="utilityMetric"><small>Auto approve</small><strong>${room.autoApprove ? 'ON' : 'OFF'}</strong></div>
      <div class="utilityMetric"><small>你的角色</small><strong>${escapeHtml(state.role || 'client')}</strong></div>
      <div class="utilityMetric"><small>檔案庫</small><strong>${fileCount} files</strong></div>
      <div class="utilityMetric"><small>邀請連結</small><strong>${escapeHtml(inviteLink())}</strong><button type="button" class="metricCopy" data-copy-value="${escapeHtml(inviteLink())}" data-copy-label="已複製邀請連結">Copy</button></div>
    </div><p class="utilityNote">Host 可直接在上方切換 Auto approve。邀請連結會預填加入 Room 的代碼，降低手動輸入錯誤。</p>`;
  }
  return `<div class="utilityGrid">
    <div class="utilityMetric"><small>待審核</small><strong>${pendingCount}</strong></div>
    <div class="utilityMetric"><small>已核准成員</small><strong>${memberCount}</strong></div>
    <div class="utilityMetric"><small>檔案數</small><strong>${fileCount}</strong></div>
    <div class="utilityMetric"><small>狀態</small><strong>${escapeHtml(state.accessStatus)}</strong></div>
  </div><p class="utilityNote">待審核清單仍保留在左側 sidebar，Host 可以逐筆允許或拒絕。此面板補足概念圖中的審核總覽層。</p>`;
}
