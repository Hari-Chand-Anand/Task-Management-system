const state = {
  users: [],
  employees: [],
  employeeDirectory: [],
  currentUser: null,
  sessionToken: localStorage.getItem('flowdesk_session_token') || '',
  tasks: [],
  stats: null,
  parsedVoice: null,
  notifications: [],
  currentSection: 'dashboard',
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const roleLabel = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  manager: 'Manager',
  employee: 'Employee',
};

const statusLabel = {
  assigned: 'Assigned',
  accepted: 'Accepted',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  under_review: 'Under Review',
  completed: 'Completed',
  delayed: 'Delayed',
};

const priorityLabel = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.sessionToken) headers['x-session-token'] = state.sessionToken;
  return fetch(path, { ...options, headers }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || 'Something went wrong');
    return data;
  });
}

function toast(message, type = 'default') {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  el.style.background = type === 'error' ? 'rgba(255, 59, 48, 0.94)' : 'rgba(29, 29, 31, 0.92)';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.add('hidden'), 3400);
}

function formatDate(value) {
  if (!value) return 'No deadline';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatDateTimeLocal(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isManagerRole(user = state.currentUser) {
  return ['super_admin', 'admin', 'manager'].includes(user?.role);
}

function initials(name = 'U') {
  return String(name || 'U').split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function escapeHtml(text = '') {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setManagerVisibility() {
  $$('.manager-only').forEach((el) => {
    el.style.display = isManagerRole() ? '' : 'none';
  });
  $('#workloadCard').style.display = isManagerRole() ? '' : 'none';
  $('#mobileQuickAssignBtn').style.display = isManagerRole() ? '' : 'none';
}

async function bootstrap() {
  try {
    const data = await api('/api/bootstrap');
    state.users = data.users;
    state.employees = state.users.filter((user) => user.role === 'employee' && user.is_active !== false);
    renderEmployeeOptions();
    $('#dateLabel').textContent = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(new Date());
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function refreshActiveUsers() {
  const data = await api('/api/bootstrap');
  state.users = data.users;
  state.employees = state.users.filter((user) => user.role === 'employee' && user.is_active !== false);
  renderEmployeeOptions();
}

function renderLoginUsers() {
  // Email/password login is used now. This function is kept as a harmless compatibility no-op.
}

function renderEmployeeOptions() {
  const options = state.employees.length
    ? state.employees.map((user) => `<option value="${user.id}">${escapeHtml(user.name)} — ${escapeHtml(user.department || 'Team')}</option>`).join('')
    : '<option value="">No active employees found</option>';
  ['#assignedTo', '#assigneeFilter'].forEach((selector) => {
    const select = $(selector);
    if (!select) return;
    if (selector === '#assigneeFilter') select.innerHTML = `<option value="all">All Employees</option>${options}`;
    else select.innerHTML = options;
  });
}

async function enterApp(user) {
  state.currentUser = user;
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#currentUserName').textContent = user.name;
  $('#currentUserRole').textContent = roleLabel[user.role] || user.role;
  $('#mobileUserLabel').textContent = `${user.name} · ${roleLabel[user.role] || user.role}`;
  $('#userAvatar').textContent = initials(user.name);
  $('#taskBoardTitle').textContent = isManagerRole() ? 'All Team Tasks' : 'My Assigned Tasks';
  setManagerVisibility();
  await refreshActiveUsers();
  renderEmployeeOptions();
  await loadAll();
  showSection('dashboard');
}

async function login() {
  const email = $('#loginEmail').value.trim();
  const password = $('#loginPassword').value;
  if (!email || !password) return toast('Please enter email and password.', 'error');
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    state.sessionToken = data.token;
    localStorage.setItem('flowdesk_session_token', data.token);
    await enterApp(data.user);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function logout() {
  try {
    if (state.sessionToken) await api('/api/logout', { method: 'POST' });
  } catch {}
  state.currentUser = null;
  state.sessionToken = '';
  localStorage.removeItem('flowdesk_session_token');
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  $('#loginPassword').value = '';
  closeMobileMenu();
}

async function loadAll() {
  await Promise.all([loadStats(), loadTasks(), loadNotifications()]);
}

async function loadStats() {
  try {
    state.stats = await api('/api/stats');
    renderStats();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function taskQueryParams() {
  const params = new URLSearchParams();
  const status = $('#statusFilter')?.value || 'all';
  const priority = $('#priorityFilter')?.value || 'all';
  const assignee = $('#assigneeFilter')?.value || 'all';
  const due = $('#dueFilter')?.value || 'all';
  const search = $('#taskSearch')?.value || '';
  if (status) params.set('status', status);
  if (priority) params.set('priority', priority);
  if (due) params.set('due', due);
  if (isManagerRole() && assignee) params.set('assignee', assignee);
  if (search) params.set('search', search);
  return params.toString();
}

async function loadTasks() {
  try {
    state.tasks = await api(`/api/tasks?${taskQueryParams()}`);
    renderTasks();
    renderPriorityTasks();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadEmployeeDirectory() {
  if (!isManagerRole()) return;
  try {
    state.employeeDirectory = await api('/api/users?include_inactive=true');
    renderEmployeeDirectory();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderEmployeeDirectory() {
  const list = $('#employeeDirectory');
  if (!list) return;
  const rows = state.employeeDirectory || [];
  list.innerHTML = rows.length
    ? rows.map((user) => `
      <article class="employee-item ${user.is_active === false ? 'inactive' : ''}">
        <div class="employee-avatar">${initials(user.name)}</div>
        <div class="employee-info">
          <strong>${escapeHtml(user.name)}</strong>
          <span>${escapeHtml(user.email)}</span>
          <small>${roleLabel[user.role] || user.role} · ${escapeHtml(user.department || 'Team')}</small>
        </div>
        <div class="employee-actions">
          <span class="badge ${user.is_active === false ? 'delayed' : 'completed'}">${user.is_active === false ? 'Inactive' : 'Active'}</span>
          <button class="ghost-btn" onclick="editEmployee('${user.id}')">Edit</button>
          ${user.is_active === false
            ? `<button class="ghost-btn" onclick="toggleEmployeeActive('${user.id}', true)">Activate</button>`
            : `<button class="ghost-btn danger-text" onclick="toggleEmployeeActive('${user.id}', false)">Deactivate</button>`}
        </div>
      </article>`).join('')
    : '<p class="muted">No employees found.</p>';
}

function clearEmployeeForm() {
  $('#employeeId').value = '';
  $('#employeeName').value = '';
  $('#employeeEmail').value = '';
  $('#employeePassword').value = '';
  $('#employeeRole').value = 'employee';
  $('#employeeDepartment').value = '';
  $('#employeeActive').checked = true;
  $('#employeeFormTitle').textContent = 'Add new employee';
  $('#employeePassword').required = true;
  $('#employeePasswordNote').textContent = 'Required for new employees. While editing, leave blank to keep existing password.';
}

function editEmployee(userId) {
  const user = state.employeeDirectory.find((item) => item.id === userId);
  if (!user) return;
  $('#employeeId').value = user.id;
  $('#employeeName').value = user.name || '';
  $('#employeeEmail').value = user.email || '';
  $('#employeePassword').value = '';
  $('#employeePassword').required = false;
  $('#employeePasswordNote').textContent = 'Leave blank to keep existing password, or enter a new password to reset it.';
  $('#employeeRole').value = user.role || 'employee';
  $('#employeeDepartment').value = user.department || '';
  $('#employeeActive').checked = user.is_active !== false;
  $('#employeeFormTitle').textContent = `Edit ${user.name}`;
  showSection('employees');
  $('#employeeName').focus();
}

async function saveEmployee(event) {
  event.preventDefault();
  if (!isManagerRole()) return toast('Only admin, manager, or super admin can manage employees.', 'error');
  const employeeId = $('#employeeId').value;
  const payload = {
    name: $('#employeeName').value.trim(),
    email: $('#employeeEmail').value.trim(),
    role: $('#employeeRole').value,
    department: $('#employeeDepartment').value.trim(),
    is_active: $('#employeeActive').checked,
  };
  const password = $('#employeePassword').value;
  if (!employeeId || password) payload.password = password;
  try {
    if (employeeId) {
      await api(`/api/users/${employeeId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      toast('Employee updated successfully.');
    } else {
      await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
      toast('Employee added successfully.');
    }
    clearEmployeeForm();
    await refreshActiveUsers();
    await loadEmployeeDirectory();
    await loadAll();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function toggleEmployeeActive(userId, isActive) {
  try {
    if (isActive) {
      await api(`/api/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ is_active: true }) });
      toast('Employee activated.');
    } else {
      await api(`/api/users/${userId}`, { method: 'DELETE' });
      toast('Employee deactivated.');
    }
    await refreshActiveUsers();
    await loadEmployeeDirectory();
    await loadAll();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderStats() {
  const stats = state.stats || {};
  $('#statTotal').textContent = stats.total ?? 0;
  $('#statProgress').textContent = stats.in_progress ?? 0;
  $('#statBlocked').textContent = stats.blocked ?? 0;
  $('#statOverdue').textContent = stats.overdue ?? 0;
  $('#avgProgress').textContent = `${stats.average_progress ?? 0}% avg`;
  const unread = stats.unread_notifications || 0;
  $('#navUnread').textContent = unread;
  $('#navUnread').classList.toggle('hidden', unread === 0);

  const workload = $('#workloadList');
  if (!isManagerRole() || !workload) return;
  const rows = stats.workload || [];
  workload.innerHTML = rows.length
    ? rows.map((item) => `
      <div class="workload-item">
        <header><strong>${escapeHtml(item.name)}</strong><span class="pill">${item.open_tasks} open</span></header>
        <div class="task-meta">${escapeHtml(item.department || 'Team')} · ${item.total_tasks} total · ${item.blocked_tasks || 0} blocked · ${item.overdue_tasks || 0} overdue</div>
        <div class="progress-wrap"><div class="progress-label"><span>Average Progress</span><strong>${item.average_progress}%</strong></div><div class="progress-track"><div class="progress-fill" style="width:${item.average_progress}%"></div></div></div>
      </div>`).join('')
    : '<p class="muted">No employee workload yet.</p>';
}

function renderPriorityTasks() {
  const list = $('#priorityTasks');
  const priority = [...state.tasks]
    .filter((task) => task.status !== 'completed')
    .sort((a, b) => {
      const order = { urgent: 0, high: 1, medium: 2, low: 3 };
      return (order[a.priority] ?? 5) - (order[b.priority] ?? 5);
    })
    .slice(0, 5);
  list.innerHTML = priority.length ? priority.map(taskCardHtml).join('') : '<p class="muted">No open priority tasks.</p>';
}

function renderTasks() {
  const list = $('#taskList');
  if (!list) return;
  list.innerHTML = state.tasks.length ? state.tasks.map(taskCardHtml).join('') : '<p class="muted">No tasks found.</p>';
}

function taskCardHtml(task) {
  const due = task.due_date ? new Date(task.due_date) : null;
  const overdue = due && due < new Date() && task.status !== 'completed';
  return `
    <article class="task-card ${overdue ? 'overdue-card' : ''}" data-task-id="${task.id}">
      <div class="task-card-top">
        <div>
          <p class="task-title">${escapeHtml(task.title)}</p>
          <div class="task-meta">
            ${isManagerRole() ? `Assigned to ${escapeHtml(task.assigned_to_name || 'Unknown')}` : `Assigned by ${escapeHtml(task.assigned_by_name || 'Manager')}`}
            · Due: ${formatDate(task.due_date)} ${overdue ? '· Overdue' : ''}
          </div>
        </div>
        <div class="task-badges"><span class="badge ${task.priority}">${priorityLabel[task.priority] || task.priority}</span><span class="badge ${task.status}">${statusLabel[task.status] || task.status}</span></div>
      </div>
      <div class="progress-wrap"><div class="progress-label"><span>Progress</span><strong>${task.progress || 0}%</strong></div><div class="progress-track"><div class="progress-fill" style="width:${task.progress || 0}%"></div></div></div>
      <div class="task-actions">
        <button class="ghost-btn" onclick="openTask('${task.id}')">View / Edit</button>
        ${task.status === 'assigned' ? `<button class="ghost-btn" onclick="quickStatus('${task.id}', 'accepted')">Accept</button>` : ''}
        ${task.status !== 'completed' ? `<button class="ghost-btn" onclick="quickStatus('${task.id}', 'in_progress')">Start</button>` : ''}
        ${task.status !== 'completed' ? `<button class="ghost-btn" onclick="quickStatus('${task.id}', 'completed')">Complete</button>` : ''}
      </div>
    </article>`;
}

function showSection(section) {
  if (!isManagerRole() && ['assign', 'employees'].includes(section)) section = 'dashboard';
  state.currentSection = section;
  $$('.content-section').forEach((el) => el.classList.add('hidden'));
  $(`#${section}Section`)?.classList.remove('hidden');
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.section === section));
  const titles = { dashboard: 'Dashboard', assign: 'Assign Task', employees: 'Employees', tasks: isManagerRole() ? 'Team Tasks' : 'My Tasks', notifications: 'Notifications', search: 'Smart Search', reports: 'Reports' };
  $('#pageTitle').textContent = titles[section] || 'Dashboard';
  if (section === 'employees') loadEmployeeDirectory();
  if (section === 'notifications') loadNotifications();
  if (section === 'reports') loadReports();
  closeMobileMenu();
}

async function createTask(event) {
  event.preventDefault();
  if (!isManagerRole()) return toast('Only admins and managers can assign tasks.', 'error');
  if (!$('#assignedTo').value) return toast('Please add an active employee before assigning a task.', 'error');
  const payload = {
    assigned_to: $('#assignedTo').value,
    title: $('#taskTitle').value.trim(),
    description: $('#taskDescription').value.trim(),
    priority: $('#priority').value,
    due_date: $('#dueDate').value ? new Date($('#dueDate').value).toISOString() : null,
  };
  try {
    await api('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
    $('#taskForm').reset();
    $('#priority').value = 'medium';
    toast('Task assigned successfully.');
    await loadAll();
    showSection('tasks');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function quickStatus(taskId, status) {
  try {
    const task = getTask(taskId);
    const payload = { status };
    if (status === 'accepted') payload.progress = Math.max(5, task?.progress || 0);
    if (status === 'in_progress') payload.progress = Math.max(10, task?.progress || 0);
    if (status === 'under_review') payload.progress = Math.max(90, task?.progress || 0);
    if (status === 'completed') payload.progress = 100;
    await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    toast(`Task marked as ${statusLabel[status]}.`);
    await loadAll();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function getTask(taskId) {
  return state.tasks.find((task) => task.id === taskId);
}

function employeeSelectHtml(selectedId) {
  return state.employees.map((user) => `<option value="${user.id}" ${user.id === selectedId ? 'selected' : ''}>${escapeHtml(user.name)} — ${escapeHtml(user.department || 'Team')}</option>`).join('');
}

async function openTask(taskId) {
  try {
    const data = await api(`/api/tasks/${taskId}`);
    const task = data.task;
    $('#dialogTitle').textContent = task.title;
    const managerFields = isManagerRole() ? `
      <label>Task title<input id="dialogTaskTitle" value="${escapeHtml(task.title || '')}" /></label>
      <label>Description<textarea id="dialogTaskDescription" rows="4">${escapeHtml(task.description || '')}</textarea></label>
      <div class="form-row">
        <label>Assigned To<select id="dialogAssignedTo">${employeeSelectHtml(task.assigned_to)}</select></label>
        <label>Priority<select id="dialogPriority">${Object.keys(priorityLabel).map((value) => `<option value="${value}" ${value === task.priority ? 'selected' : ''}>${priorityLabel[value]}</option>`).join('')}</select></label>
      </div>
      <label>Due Date<input id="dialogDueDate" type="datetime-local" value="${task.due_date ? formatDateTimeLocal(task.due_date) : ''}" /></label>` : `<p class="muted">${escapeHtml(task.description || 'No description added.')}</p>`;

    $('#dialogBody').innerHTML = `
      <div class="detail-grid">
        <div class="detail-cell"><span>Status</span><strong>${statusLabel[task.status] || task.status}</strong></div>
        <div class="detail-cell"><span>Priority</span><strong>${priorityLabel[task.priority] || task.priority}</strong></div>
        <div class="detail-cell"><span>Assigned To</span><strong>${escapeHtml(task.assigned_to_name || '-')}</strong></div>
        <div class="detail-cell"><span>Due Date</span><strong>${formatDate(task.due_date)}</strong></div>
      </div>
      <div class="comment-box task-form">
        ${managerFields}
        <div class="form-row">
          <label>Status<select id="dialogStatus">${Object.entries(statusLabel).map(([value, label]) => `<option value="${value}" ${value === task.status ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
          <label>Progress<input id="dialogProgress" type="number" min="0" max="100" value="${task.progress || 0}" /></label>
        </div>
        <div class="dialog-actions">
          <button class="primary-btn" onclick="updateTaskFromDialog('${task.id}')">Save Changes</button>
          <button class="ghost-btn" onclick="quickDialogStatus('${task.id}', 'blocked')">Mark Blocked</button>
          <button class="ghost-btn" onclick="quickDialogStatus('${task.id}', 'under_review')">Send Review</button>
          ${isManagerRole() ? `<button class="ghost-btn danger-text" onclick="deleteTaskFromDialog('${task.id}')">Delete Task</button>` : ''}
        </div>
      </div>
      <div class="comment-box">
        <h3>Comments</h3>
        <div>${data.comments.length ? data.comments.map((comment) => `<div class="comment-item"><strong>${escapeHtml(comment.user_name || 'User')}</strong><br>${escapeHtml(comment.comment)}<br><span class="muted">${formatDate(comment.created_at)}</span></div>`).join('') : '<p class="muted">No comments yet.</p>'}</div>
        <textarea id="newComment" rows="3" placeholder="Add progress note or blocker update..."></textarea>
        <button class="ghost-btn" onclick="addComment('${task.id}')">Add Comment</button>
      </div>
      <div class="comment-box">
        <h3>Activity</h3>
        <div>${data.logs.length ? data.logs.slice(0, 12).map((log) => `<div class="log-item"><strong>${escapeHtml(log.action)}</strong> by ${escapeHtml(log.performed_by_name || 'System')}<br><span class="muted">${formatDate(log.created_at)}</span></div>`).join('') : '<p class="muted">No activity yet.</p>'}</div>
      </div>`;
    $('#taskDialog').showModal();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function updateTaskFromDialog(taskId) {
  try {
    const payload = { status: $('#dialogStatus').value, progress: Number($('#dialogProgress').value || 0) };
    if (isManagerRole()) {
      payload.title = $('#dialogTaskTitle').value.trim();
      payload.description = $('#dialogTaskDescription').value.trim();
      payload.assigned_to = $('#dialogAssignedTo').value;
      payload.priority = $('#dialogPriority').value;
      payload.due_date = $('#dialogDueDate').value ? new Date($('#dialogDueDate').value).toISOString() : null;
    }
    await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    toast('Task updated.');
    await loadAll();
    await openTask(taskId);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function quickDialogStatus(taskId, status) {
  await quickStatus(taskId, status);
  await openTask(taskId);
}

async function deleteTaskFromDialog(taskId) {
  if (!isManagerRole()) return;
  if (!confirm('Delete this task permanently?')) return;
  try {
    await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
    toast('Task deleted.');
    $('#taskDialog').close();
    await loadAll();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function addComment(taskId) {
  const comment = $('#newComment').value.trim();
  if (!comment) return;
  try {
    await api(`/api/tasks/${taskId}/comments`, { method: 'POST', body: JSON.stringify({ comment }) });
    toast('Comment added.');
    await openTask(taskId);
    await loadNotifications();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function parseVoiceCommand(text) {
  const lower = text.toLowerCase();
  const employee = state.employees.find((user) => lower.includes(user.name.toLowerCase()) || lower.includes(user.name.toLowerCase().split(' ')[0])) || state.employees[0];
  let priority = 'medium';
  if (lower.includes('urgent')) priority = 'urgent';
  else if (lower.includes('high')) priority = 'high';
  else if (lower.includes('low')) priority = 'low';

  const due = new Date();
  if (lower.includes('tomorrow')) due.setDate(due.getDate() + 1);
  if (lower.includes('today')) due.setDate(due.getDate());
  const weekDays = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  for (const [name, index] of Object.entries(weekDays)) {
    if (lower.includes(name)) {
      const diff = (index - due.getDay() + 7) % 7 || 7;
      due.setDate(due.getDate() + diff);
      break;
    }
  }
  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (timeMatch) {
    let hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2] || 0);
    const meridian = timeMatch[3];
    if (meridian === 'pm' && hours < 12) hours += 12;
    if (meridian === 'am' && hours === 12) hours = 0;
    due.setHours(hours, minutes, 0, 0);
  } else if (lower.includes('morning')) due.setHours(10, 0, 0, 0);
  else if (lower.includes('evening')) due.setHours(17, 0, 0, 0);
  else due.setHours(18, 0, 0, 0);

  const employeeFirst = employee?.name?.split(' ')[0] || '';
  let title = text
    .replace(/assign\s+/i, '')
    .replace(new RegExp(employeeFirst, 'i'), '')
    .replace(/^\s*to\s+/i, '')
    .replace(/with\s+(urgent|high|medium|low)\s+priority/i, '')
    .replace(/by\s+.*$/i, '')
    .replace(/before\s+.*$/i, '')
    .trim();
  if (!title || title.length < 4) title = text;
  title = title.charAt(0).toUpperCase() + title.slice(1);

  return { assigned_to: employee?.id, assigned_to_name: employee?.name, title, description: text, priority, due_date: due };
}

function renderParsedPreview(parsed) {
  $('#parsedPreview').innerHTML = `<div><strong>Employee:</strong> ${escapeHtml(parsed.assigned_to_name || '-')}</div><div><strong>Task:</strong> ${escapeHtml(parsed.title || '-')}</div><div><strong>Priority:</strong> ${priorityLabel[parsed.priority] || parsed.priority}</div><div><strong>Due:</strong> ${formatDate(parsed.due_date)}</div>`;
}

function setupVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('#voiceBtn');
  if (!btn) return;
  if (!SpeechRecognition) {
    btn.addEventListener('click', () => toast('Voice input is not supported in this browser. Use Chrome or Edge.', 'error'));
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = 'en-IN';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.onstart = () => { btn.classList.add('listening'); btn.querySelector('strong').textContent = 'Listening...'; };
  recognition.onend = () => { btn.classList.remove('listening'); btn.querySelector('strong').textContent = 'Start Voice'; };
  recognition.onerror = (event) => toast(`Voice error: ${event.error}`, 'error');
  recognition.onresult = (event) => {
    const transcript = Array.from(event.results).map((result) => result[0].transcript).join(' ');
    $('#transcriptText').textContent = transcript;
    if (event.results[event.results.length - 1].isFinal) {
      state.parsedVoice = parseVoiceCommand(transcript);
      renderParsedPreview(state.parsedVoice);
    }
  };
  btn.addEventListener('click', () => recognition.start());
}

function applyParsedToForm() {
  if (!state.parsedVoice) return toast('No parsed voice preview available.', 'error');
  $('#assignedTo').value = state.parsedVoice.assigned_to;
  $('#taskTitle').value = state.parsedVoice.title;
  $('#taskDescription').value = state.parsedVoice.description;
  $('#priority').value = state.parsedVoice.priority;
  $('#dueDate').value = formatDateTimeLocal(state.parsedVoice.due_date);
  toast('Voice preview applied. Review once, then confirm assignment.');
}

async function smartSearch() {
  const query = $('#smartSearchInput').value.trim();
  if (!query) return;
  try {
    const results = await api(`/api/search?q=${encodeURIComponent(query)}`);
    $('#smartResults').innerHTML = results.length
      ? results.map((task) => `${taskCardHtml(task)}${task.score ? `<div class="small-note">Similarity score: ${Number(task.score).toFixed(3)}</div>` : ''}`).join('')
      : '<p class="muted">No related tasks found.</p>';
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadNotifications() {
  if (!state.currentUser) return;
  try {
    state.notifications = await api('/api/notifications');
    renderNotifications();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderNotifications() {
  const list = $('#notificationList');
  if (!list) return;
  const unread = state.notifications.filter((n) => !n.is_read).length;
  $('#navUnread').textContent = unread;
  $('#navUnread').classList.toggle('hidden', unread === 0);
  list.innerHTML = state.notifications.length
    ? state.notifications.map((note) => `<article class="notification-item ${note.is_read ? '' : 'unread'}"><div><strong>${escapeHtml(note.title)}</strong><p>${escapeHtml(note.message)}</p><span>${formatDate(note.created_at)}</span></div>${note.is_read ? '<span class="pill">Read</span>' : `<button class="ghost-btn" onclick="markNotificationRead('${note.id}')">Mark read</button>`}</article>`).join('')
    : '<p class="muted">No notifications yet.</p>';
}

async function markNotificationRead(id) {
  try {
    await api(`/api/notifications/${id}/read`, { method: 'PATCH' });
    await loadNotifications();
    await loadStats();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function markAllNotificationsRead() {
  try {
    await api('/api/notifications/read-all', { method: 'PATCH' });
    toast('All notifications marked as read.');
    await loadNotifications();
    await loadStats();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadReports() {
  try {
    const data = await api('/api/reports/summary');
    const statusRows = data.by_status || [];
    const priorityRows = data.by_priority || [];
    $('#reportGrid').innerHTML = `
      <article class="report-card"><span>Overdue</span><strong>${data.overdue || 0}</strong><p>Open tasks past due date</p></article>
      <article class="report-card"><span>Status Split</span>${statusRows.map((row) => `<div class="report-row"><b>${statusLabel[row.status] || row.status}</b><em>${row.count}</em></div>`).join('') || '<p class="muted">No status data</p>'}</article>
      <article class="report-card"><span>Priority Split</span>${priorityRows.map((row) => `<div class="report-row"><b>${priorityLabel[row.priority] || row.priority}</b><em>${row.count}</em></div>`).join('') || '<p class="muted">No priority data</p>'}</article>`;
  } catch (error) {
    toast(error.message, 'error');
  }
}

function exportTasksCsv() {
  const rows = [['Title', 'Assigned To', 'Assigned By', 'Status', 'Priority', 'Progress', 'Due Date', 'Description']];
  state.tasks.forEach((task) => rows.push([task.title, task.assigned_to_name || '', task.assigned_by_name || '', statusLabel[task.status] || task.status, priorityLabel[task.priority] || task.priority, `${task.progress || 0}%`, task.due_date || '', task.description || '']));
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'flowdesk_tasks.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function resetFilters() {
  $('#statusFilter').value = 'all';
  $('#priorityFilter').value = 'all';
  $('#dueFilter').value = 'all';
  if ($('#assigneeFilter')) $('#assigneeFilter').value = 'all';
  $('#taskSearch').value = '';
  loadTasks();
}

function openMobileMenu() {
  $('#sidebar').classList.add('open');
  $('#mobileOverlay').classList.remove('hidden');
}

function closeMobileMenu() {
  $('#sidebar').classList.remove('open');
  $('#mobileOverlay').classList.add('hidden');
}

function wireEvents() {
  $('#loginBtn').addEventListener('click', login);
  $('#loginPassword').addEventListener('keydown', (event) => { if (event.key === 'Enter') login(); });
  $('#loginEmail').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#loginPassword').focus(); });
  $$('.demo-chip').forEach((button) => button.addEventListener('click', () => {
    $('#loginEmail').value = button.dataset.email;
    $('#loginPassword').value = button.dataset.password;
  }));
  $('#logoutBtn').addEventListener('click', logout);
  $('#refreshBtn').addEventListener('click', loadAll);
  $('#quickAssignBtn').addEventListener('click', () => showSection('assign'));
  $('#mobileQuickAssignBtn').addEventListener('click', () => showSection('assign'));
  $('#menuBtn').addEventListener('click', openMobileMenu);
  $('#mobileOverlay').addEventListener('click', closeMobileMenu);
  $('#taskForm').addEventListener('submit', createTask);
  $('#employeeForm').addEventListener('submit', saveEmployee);
  $('#clearEmployeeFormBtn').addEventListener('click', clearEmployeeForm);
  $('#refreshEmployeesBtn').addEventListener('click', loadEmployeeDirectory);
  ['#statusFilter', '#priorityFilter', '#assigneeFilter', '#dueFilter'].forEach((selector) => $(selector)?.addEventListener('change', loadTasks));
  $('#taskSearch').addEventListener('input', () => { clearTimeout(window.__taskSearchTimer); window.__taskSearchTimer = setTimeout(loadTasks, 250); });
  $('#resetFiltersBtn').addEventListener('click', resetFilters);
  $('#exportTasksBtn').addEventListener('click', exportTasksCsv);
  $('#closeDialogBtn').addEventListener('click', () => $('#taskDialog').close());
  $('#applyParsedBtn').addEventListener('click', applyParsedToForm);
  $('#smartSearchBtn').addEventListener('click', smartSearch);
  $('#smartSearchInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') smartSearch(); });
  $('#markAllReadBtn').addEventListener('click', markAllNotificationsRead);
  $('#refreshReportsBtn').addEventListener('click', loadReports);
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => showSection(item.dataset.section)));
  setupVoice();
}

window.quickStatus = quickStatus;
window.openTask = openTask;
window.updateTaskFromDialog = updateTaskFromDialog;
window.quickDialogStatus = quickDialogStatus;
window.deleteTaskFromDialog = deleteTaskFromDialog;
window.addComment = addComment;
window.editEmployee = editEmployee;
window.toggleEmployeeActive = toggleEmployeeActive;
window.markNotificationRead = markNotificationRead;

(async function init() {
  wireEvents();
  await bootstrap();
  if (state.sessionToken) {
    try {
      const user = await api('/api/me');
      await enterApp(user);
    } catch {
      state.sessionToken = '';
      localStorage.removeItem('flowdesk_session_token');
    }
  }
})();
