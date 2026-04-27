require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://flowdesk:flowdesk_password@localhost:5432/flowdesk';
const QDRANT_URL = (process.env.QDRANT_URL || 'http://localhost:6333').replace(/\/$/, '');
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || 'tasks_vectors';
const VECTOR_SIZE = Number(process.env.VECTOR_SIZE || 384);

const pool = new Pool({ connectionString: DATABASE_URL });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ROLES = ['super_admin', 'admin', 'manager', 'employee'];
const TASK_STATUSES = ['assigned', 'accepted', 'in_progress', 'blocked', 'under_review', 'completed', 'delayed'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}


function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash = '') {
  const [salt, hash] = String(storedHash || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex')); }
  catch { return false; }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function publicUser(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  return safe;
}


function qdrantPointId(taskId = '') {
  const raw = String(taskId || '');
  const stripped = raw.startsWith('task_') ? raw.slice(5) : raw;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(stripped)) return stripped;

  // Qdrant point IDs must be unsigned integers or UUIDs. Our app task IDs are text,
  // so we create a deterministic UUID from the task ID for Qdrant only.
  const hex = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeText(input = '') {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deterministicEmbedding(text = '', size = VECTOR_SIZE) {
  const vector = new Array(size).fill(0);
  const words = normalizeText(text).split(' ').filter(Boolean);

  if (!words.length) {
    vector[0] = 1;
    return vector;
  }

  for (const word of words) {
    const hash = crypto.createHash('sha256').update(word).digest();
    for (let i = 0; i < hash.length; i += 2) {
      const index = ((hash[i] << 8) + hash[i + 1]) % size;
      vector[index] += 1;
    }
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

async function qdrantFetch(endpoint, options = {}) {
  const response = await fetch(`${QDRANT_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const message = body?.status?.error || body?.message || response.statusText;
    throw new Error(`Qdrant ${response.status}: ${message}`);
  }

  return body;
}

async function ensureQdrantCollection() {
  try {
    await qdrantFetch(`/collections/${QDRANT_COLLECTION}`);
    return { ok: true, message: 'Qdrant collection already exists' };
  } catch (error) {
    try {
      await qdrantFetch(`/collections/${QDRANT_COLLECTION}`, {
        method: 'PUT',
        body: JSON.stringify({ vectors: { size: VECTOR_SIZE, distance: 'Cosine' } }),
      });
      return { ok: true, message: 'Qdrant collection created' };
    } catch (createError) {
      console.warn('Qdrant init skipped:', createError.message);
      return { ok: false, message: createError.message };
    }
  }
}

async function upsertTaskVector(task) {
  try {
    const embeddingText = `${task.title || ''} ${task.description || ''} ${task.priority || ''} ${task.status || ''}`;
    const vector = deterministicEmbedding(embeddingText);
    await qdrantFetch(`/collections/${QDRANT_COLLECTION}/points?wait=true`, {
      method: 'PUT',
      body: JSON.stringify({
        points: [
          {
            id: qdrantPointId(task.id),
            vector,
            payload: {
              task_id: task.id,
              title: task.title,
              description: task.description,
              assigned_to: task.assigned_to,
              assigned_by: task.assigned_by,
              status: task.status,
              priority: task.priority,
              due_date: task.due_date,
              progress: task.progress,
            },
          },
        ],
      }),
    });
    return true;
  } catch (error) {
    console.warn('Qdrant upsert skipped:', error.message);
    return false;
  }
}

async function deleteTaskVector(taskId) {
  try {
    await qdrantFetch(`/collections/${QDRANT_COLLECTION}/points/delete?wait=true`, {
      method: 'POST',
      body: JSON.stringify({ points: [qdrantPointId(taskId)] }),
    });
  } catch (error) {
    console.warn('Qdrant delete skipped:', error.message);
  }
}

async function searchQdrant(query, user) {
  const vector = deterministicEmbedding(query);
  const filter = user.role === 'employee'
    ? { must: [{ key: 'assigned_to', match: { value: user.id } }] }
    : undefined;

  const body = { vector, limit: 12, with_payload: true, with_vector: false };
  if (filter) body.filter = filter;

  const result = await qdrantFetch(`/collections/${QDRANT_COLLECTION}/points/search`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return result?.result || [];
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT CHECK (role IN ('super_admin', 'admin', 'manager', 'employee')) NOT NULL,
      department TEXT,
      avatar_url TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      password_hash TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      assigned_to TEXT REFERENCES users(id),
      assigned_by TEXT REFERENCES users(id),
      status TEXT CHECK (status IN ('assigned', 'accepted', 'in_progress', 'blocked', 'under_review', 'completed', 'delayed')) DEFAULT 'assigned',
      priority TEXT CHECK (priority IN ('low', 'medium', 'high', 'urgent')) DEFAULT 'medium',
      progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
      due_date TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id),
      comment TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS task_activity_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      performed_by TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const users = [
    ['u_super', 'Anil Anand', 'anil@hca.local', 'super_admin', 'Leadership', 'Admin@123'],
    ['u_admin', 'Bhavya Anand', 'bhavya@hca.local', 'admin', 'Leadership', 'Admin@123'],
    ['u_neha', 'Neha Singh', 'neha@hca.local', 'manager', 'Operations', 'Admin@123'],
    ['u_rahul', 'Rahul Verma', 'rahul@hca.local', 'employee', 'Sales', 'Employee@123'],
    ['u_priya', 'Priya Sharma', 'priya@hca.local', 'employee', 'Accounts', 'Employee@123'],
    ['u_amit', 'Amit Kumar', 'amit@hca.local', 'employee', 'Service', 'Employee@123'],
    ['u_vashu', 'Vashu Mehta', 'vashu@hca.local', 'employee', 'IT', 'Employee@123'],
  ];

  for (const user of users) {
    const [id, name, email, role, department, password] = user;
    await pool.query(
      `INSERT INTO users (id, name, email, role, department, is_active, password_hash)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)
       ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        email = EXCLUDED.email,
        role = EXCLUDED.role,
        department = EXCLUDED.department,
        is_active = COALESCE(users.is_active, TRUE),
        password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash)`,
      [id, name, email, role, department, hashPassword(password)],
    );
  }

  await pool.query('UPDATE users SET password_hash = $1 WHERE password_hash IS NULL', [hashPassword('Employee@123')]);

  const count = await pool.query('SELECT COUNT(*)::int AS count FROM tasks');
  if (count.rows[0].count === 0) {
    const seedTasks = [
      {
        title: 'Prepare daily sales report',
        description: 'Compile today\'s branch-wise sales updates and submit the summary before evening review.',
        assigned_to: 'u_rahul',
        assigned_by: 'u_admin',
        status: 'in_progress',
        priority: 'high',
        progress: 55,
        due_date: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
      },
      {
        title: 'Update vendor payment status',
        description: 'Check pending vendor payments and share remarks for delayed items.',
        assigned_to: 'u_priya',
        assigned_by: 'u_neha',
        status: 'assigned',
        priority: 'urgent',
        progress: 0,
        due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        title: 'Review service ticket blockers',
        description: 'Identify blocked service tickets and update reason, owner, and expected closure timeline.',
        assigned_to: 'u_amit',
        assigned_by: 'u_admin',
        status: 'blocked',
        priority: 'medium',
        progress: 30,
        due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        title: 'Fix website update task sync',
        description: 'Check why employee sheet updates are not syncing correctly with Bhavya dashboard.',
        assigned_to: 'u_vashu',
        assigned_by: 'u_neha',
        status: 'under_review',
        priority: 'high',
        progress: 80,
        due_date: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      },
    ];

    for (const task of seedTasks) {
      const id = newId('task_');
      await pool.query(
        `INSERT INTO tasks (id, title, description, assigned_to, assigned_by, status, priority, progress, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, task.title, task.description, task.assigned_to, task.assigned_by, task.status, task.priority, task.progress, task.due_date],
      );
      await pool.query(
        `INSERT INTO task_activity_logs (id, task_id, action, new_value, performed_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [newId('log_'), id, 'created', task.status, task.assigned_by],
      );
    }
  }
}

async function reindexAllTasks() {
  const result = await pool.query('SELECT * FROM tasks');
  for (const task of result.rows) {
    await upsertTaskVector(task);
  }
}

async function getUser(userId, includeInactive = false) {
  if (!userId) return null;
  const result = await pool.query(
    includeInactive
      ? 'SELECT * FROM users WHERE id = $1'
      : 'SELECT * FROM users WHERE id = $1 AND COALESCE(is_active, TRUE) = TRUE',
    [userId],
  );
  return result.rows[0] || null;
}

async function getUserFromSessionToken(token) {
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.* FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.expires_at > NOW()
       AND COALESCE(u.is_active, TRUE) = TRUE`,
    [hashToken(token)],
  );
  return result.rows[0] || null;
}

function canManageTasks(user) {
  return ['super_admin', 'admin', 'manager'].includes(user?.role);
}

async function requireUser(req, res, next) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const sessionToken = req.headers['x-session-token'] || bearer;
  const user = await getUserFromSessionToken(sessionToken);
  if (!user) {
    return res.status(401).json({ error: 'Please login again. Valid session token is required.' });
  }
  req.currentUser = user;
  return next();
}

function applyTaskPrivacyWhere(user, baseWhere = 'WHERE 1=1', params = []) {
  if (user.role === 'employee') {
    params.push(user.id);
    return { where: `${baseWhere} AND t.assigned_to = $${params.length}`, params };
  }
  return { where: baseWhere, params };
}

function validateRole(role) {
  return ROLES.includes(role);
}

function validateStatus(status) {
  return TASK_STATUSES.includes(status);
}

function validatePriority(priority) {
  return PRIORITIES.includes(priority);
}

let appReadyPromise = null;

function ensureAppReady() {
  if (!appReadyPromise) {
    appReadyPromise = (async () => {
      await initDb();
      await ensureQdrantCollection();
      if (process.env.SKIP_QDRANT_REINDEX !== 'true') {
        await reindexAllTasks();
      }
    })();
  }
  return appReadyPromise;
}

// Initialize DB/Qdrant before API requests. This keeps the same code working
// both locally and on Vercel's serverless/Fluid Compute runtime.
app.use(async (req, res, next) => {
  try {
    await ensureAppReady();
    return next();
  } catch (error) {
    console.error('Application initialization failed:', error);
    return res.status(500).json({ error: 'Application initialization failed. Please check DATABASE_URL and QDRANT_URL.' });
  }
});

app.post('/api/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const result = await pool.query(
    `SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND COALESCE(is_active, TRUE) = TRUE`,
    [email],
  );
  const user = result.rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')`,
    [newId('session_'), user.id, hashToken(token)],
  );
  res.json({ user: publicUser(user), token });
});

app.post('/api/logout', requireUser, async (req, res) => {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const sessionToken = req.headers['x-session-token'] || bearer;
  if (sessionToken) await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [hashToken(sessionToken)]);
  res.json({ ok: true });
});

app.get('/api/me', requireUser, async (req, res) => {
  res.json(publicUser(req.currentUser));
});

app.get('/api/health', async (req, res) => {
  let postgres = false;
  let qdrant = false;
  try {
    await pool.query('SELECT 1');
    postgres = true;
  } catch {}
  try {
    await qdrantFetch('/');
    qdrant = true;
  } catch {}
  res.json({ ok: true, postgres, qdrant, time: nowIso() });
});

app.get('/api/users', requireUser, async (req, res) => {
  if (!canManageTasks(req.currentUser)) {
    return res.status(403).json({ error: 'Only admin, manager, or super admin can manage employees.' });
  }

  const includeInactive = req.query.include_inactive === 'true';
  const result = await pool.query(
    `SELECT id, name, email, role, department, avatar_url, is_active, created_at, updated_at
     FROM users
     ${includeInactive ? '' : 'WHERE COALESCE(is_active, TRUE) = TRUE'}
     ORDER BY COALESCE(is_active, TRUE) DESC, role, name`,
  );
  res.json(result.rows.map(publicUser));
});

app.get('/api/bootstrap', async (req, res) => {
  const users = await pool.query(`SELECT id, name, email, role, department, avatar_url, is_active
                                  FROM users
                                  WHERE COALESCE(is_active, TRUE) = TRUE
                                  ORDER BY role, name`);
  res.json({ users: users.rows, roles: ROLES, statuses: TASK_STATUSES, priorities: PRIORITIES });
});

app.post('/api/users', requireUser, async (req, res) => {
  if (!canManageTasks(req.currentUser)) {
    return res.status(403).json({ error: 'Only admin, manager, or super admin can add employees.' });
  }

  const { name, email, role = 'employee', department = '', is_active = true, password = '' } = req.body;
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanDepartment = String(department || '').trim();

  if (!cleanName || !cleanEmail) return res.status(400).json({ error: 'Name and email are required.' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!validateRole(role)) return res.status(400).json({ error: 'Invalid role selected.' });

  const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [cleanEmail]);
  if (existing.rows.length) return res.status(409).json({ error: 'An employee with this email already exists.' });

  const id = newId('user_');
  const result = await pool.query(
    `INSERT INTO users (id, name, email, role, department, is_active, password_hash, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
     RETURNING id, name, email, role, department, avatar_url, is_active, created_at, updated_at`,
    [id, cleanName, cleanEmail, role, cleanDepartment, Boolean(is_active), hashPassword(password)],
  );

  res.status(201).json(result.rows[0]);
});

app.patch('/api/users/:id', requireUser, async (req, res) => {
  if (!canManageTasks(req.currentUser)) {
    return res.status(403).json({ error: 'Only admin, manager, or super admin can update employees.' });
  }

  const current = await getUser(req.params.id, true);
  if (!current) return res.status(404).json({ error: 'Employee not found.' });

  const allowed = ['name', 'email', 'role', 'department', 'is_active', 'password'];
  const updates = [];
  const values = [];

  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      let value = req.body[field];
      if (field === 'email') value = String(value || '').trim().toLowerCase();
      if (field === 'name' || field === 'department') value = String(value || '').trim();
      if (field === 'is_active') value = Boolean(value);
      if (field === 'password') {
        if (!value) continue;
        if (String(value).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        value = hashPassword(value);
      }
      if (field === 'role' && !validateRole(value)) return res.status(400).json({ error: 'Invalid role selected.' });
      if (field === 'name' && !value) return res.status(400).json({ error: 'Name is required.' });
      if (field === 'email' && !value) return res.status(400).json({ error: 'Email is required.' });
      if (field === 'is_active' && value === false && req.currentUser.id === req.params.id) {
        return res.status(400).json({ error: 'You cannot deactivate your own account while logged in.' });
      }
      values.push(value);
      updates.push(`${field === 'password' ? 'password_hash' : field} = $${values.length}`);
    }
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields provided for update.' });

  if (Object.prototype.hasOwnProperty.call(req.body, 'email')) {
    const duplicate = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2',
      [String(req.body.email || '').trim().toLowerCase(), req.params.id],
    );
    if (duplicate.rows.length) return res.status(409).json({ error: 'This email is already used by another employee.' });
  }

  values.push(nowIso());
  updates.push(`updated_at = $${values.length}`);
  values.push(req.params.id);

  const result = await pool.query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = $${values.length}
     RETURNING id, name, email, role, department, avatar_url, is_active, created_at, updated_at`,
    values,
  );

  res.json(result.rows[0]);
});

app.delete('/api/users/:id', requireUser, async (req, res) => {
  if (!canManageTasks(req.currentUser)) {
    return res.status(403).json({ error: 'Only admin, manager, or super admin can deactivate employees.' });
  }
  if (req.currentUser.id === req.params.id) {
    return res.status(400).json({ error: 'You cannot deactivate your own account while logged in.' });
  }

  const result = await pool.query(
    `UPDATE users SET is_active = FALSE, updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, email, role, department, avatar_url, is_active, created_at, updated_at`,
    [req.params.id],
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Employee not found.' });
  res.json(result.rows[0]);
});

app.get('/api/tasks', requireUser, async (req, res) => {
  const user = req.currentUser;
  const { status, search, priority, assignee, due } = req.query;
  const params = [];
  let baseWhere = 'WHERE 1=1';

  if (status && status !== 'all') {
    params.push(status);
    baseWhere += ` AND t.status = $${params.length}`;
  }
  if (priority && priority !== 'all') {
    params.push(priority);
    baseWhere += ` AND t.priority = $${params.length}`;
  }
  if (assignee && assignee !== 'all' && canManageTasks(user)) {
    params.push(assignee);
    baseWhere += ` AND t.assigned_to = $${params.length}`;
  }
  if (due && due !== 'all') {
    if (due === 'overdue') baseWhere += ` AND t.due_date < NOW() AND t.status <> 'completed'`;
    if (due === 'today') baseWhere += ` AND t.due_date::date = CURRENT_DATE`;
    if (due === 'upcoming') baseWhere += ` AND t.due_date > NOW() AND t.status <> 'completed'`;
    if (due === 'no_due') baseWhere += ` AND t.due_date IS NULL`;
  }
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    baseWhere += ` AND (LOWER(t.title) LIKE $${params.length} OR LOWER(COALESCE(t.description,'')) LIKE $${params.length})`;
  }

  const { where, params: finalParams } = applyTaskPrivacyWhere(user, baseWhere, params);
  const result = await pool.query(
    `SELECT
      t.*,
      assigned_to_user.name AS assigned_to_name,
      assigned_to_user.department AS assigned_to_department,
      assigned_by_user.name AS assigned_by_name
     FROM tasks t
     LEFT JOIN users assigned_to_user ON assigned_to_user.id = t.assigned_to
     LEFT JOIN users assigned_by_user ON assigned_by_user.id = t.assigned_by
     ${where}
     ORDER BY
      CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END,
      CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      t.due_date ASC NULLS LAST,
      t.created_at DESC`,
    finalParams,
  );
  res.json(result.rows);
});

app.get('/api/tasks/:id', requireUser, async (req, res) => {
  const user = req.currentUser;
  const result = await pool.query(
    `SELECT
      t.*,
      assigned_to_user.name AS assigned_to_name,
      assigned_by_user.name AS assigned_by_name
     FROM tasks t
     LEFT JOIN users assigned_to_user ON assigned_to_user.id = t.assigned_to
     LEFT JOIN users assigned_by_user ON assigned_by_user.id = t.assigned_by
     WHERE t.id = $1`,
    [req.params.id],
  );

  const task = result.rows[0];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (user.role === 'employee' && task.assigned_to !== user.id) {
    return res.status(403).json({ error: 'Employees can only view their own tasks.' });
  }

  const comments = await pool.query(
    `SELECT c.*, u.name AS user_name, u.role AS user_role
     FROM task_comments c
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.task_id = $1
     ORDER BY c.created_at ASC`,
    [task.id],
  );

  const logs = await pool.query(
    `SELECT l.*, u.name AS performed_by_name
     FROM task_activity_logs l
     LEFT JOIN users u ON u.id = l.performed_by
     WHERE l.task_id = $1
     ORDER BY l.created_at DESC`,
    [task.id],
  );

  res.json({ task, comments: comments.rows, logs: logs.rows });
});

app.post('/api/tasks', requireUser, async (req, res) => {
  const user = req.currentUser;
  if (!canManageTasks(user)) return res.status(403).json({ error: 'Only admin, manager, or super admin can create tasks.' });

  const { title, description, assigned_to, priority = 'medium', due_date } = req.body;
  const cleanTitle = String(title || '').trim();
  const cleanDescription = String(description || '').trim();
  if (!cleanTitle || !assigned_to) return res.status(400).json({ error: 'Task title and assigned employee are required.' });
  if (!validatePriority(priority)) return res.status(400).json({ error: 'Invalid task priority.' });

  const assignedUser = await getUser(assigned_to);
  if (!assignedUser || assignedUser.role !== 'employee') {
    return res.status(400).json({ error: 'Tasks can only be assigned to active employee users.' });
  }

  const id = newId('task_');
  const created = await pool.query(
    `INSERT INTO tasks (id, title, description, assigned_to, assigned_by, status, priority, progress, due_date)
     VALUES ($1,$2,$3,$4,$5,'assigned',$6,0,$7)
     RETURNING *`,
    [id, cleanTitle, cleanDescription, assigned_to, user.id, priority, due_date ? new Date(due_date).toISOString() : null],
  );

  const task = created.rows[0];
  await pool.query(
    `INSERT INTO notifications (id, user_id, title, message)
     VALUES ($1,$2,$3,$4)`,
    [newId('note_'), assigned_to, 'New Task Assigned', `${user.name} assigned you: ${cleanTitle}`],
  );
  await pool.query(
    `INSERT INTO task_activity_logs (id, task_id, action, new_value, performed_by)
     VALUES ($1,$2,'created',$3,$4)`,
    [newId('log_'), task.id, 'assigned', user.id],
  );
  await upsertTaskVector(task);

  const enriched = await pool.query(
    `SELECT t.*, au.name AS assigned_to_name, bu.name AS assigned_by_name
     FROM tasks t
     LEFT JOIN users au ON au.id = t.assigned_to
     LEFT JOIN users bu ON bu.id = t.assigned_by
     WHERE t.id = $1`,
    [task.id],
  );
  res.status(201).json(enriched.rows[0]);
});

app.patch('/api/tasks/:id', requireUser, async (req, res) => {
  const user = req.currentUser;
  const currentResult = await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
  const current = currentResult.rows[0];

  if (!current) return res.status(404).json({ error: 'Task not found' });
  if (user.role === 'employee' && current.assigned_to !== user.id) {
    return res.status(403).json({ error: 'Employees can only update their own assigned tasks.' });
  }

  const allowedForEmployee = ['status', 'progress'];
  const allowedForManager = ['title', 'description', 'assigned_to', 'status', 'priority', 'progress', 'due_date'];
  const allowed = canManageTasks(user) ? allowedForManager : allowedForEmployee;

  const updates = [];
  const values = [];
  const logs = [];

  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      let value = req.body[field];
      if (field === 'title') {
        value = String(value || '').trim();
        if (!value) return res.status(400).json({ error: 'Task title is required.' });
      }
      if (field === 'description') value = String(value || '').trim();
      if (field === 'status' && !validateStatus(value)) return res.status(400).json({ error: 'Invalid task status.' });
      if (field === 'priority' && !validatePriority(value)) return res.status(400).json({ error: 'Invalid task priority.' });
      if (field === 'progress') {
        value = Number(value);
        if (!Number.isFinite(value) || value < 0 || value > 100) return res.status(400).json({ error: 'Progress must be between 0 and 100.' });
      }
      if (field === 'assigned_to') {
        const assignedUser = await getUser(value);
        if (!assignedUser || assignedUser.role !== 'employee') return res.status(400).json({ error: 'Assigned user must be an active employee.' });
      }
      if (field === 'due_date') value = value ? new Date(value).toISOString() : null;

      values.push(value === '' ? null : value);
      updates.push(`${field} = $${values.length}`);
      if (String(current[field] ?? '') !== String(value ?? '')) {
        logs.push({ field, oldValue: current[field], newValue: value });
      }
    }
  }

  if (!updates.length) return res.status(400).json({ error: 'No allowed fields provided for update.' });

  const incomingStatus = Object.prototype.hasOwnProperty.call(req.body, 'status') ? req.body.status : current.status;
  if (incomingStatus === 'completed') {
    values.push(nowIso());
    updates.push(`completed_at = $${values.length}`);
    const hasProgressUpdate = Object.prototype.hasOwnProperty.call(req.body, 'progress');
    const nextProgress = hasProgressUpdate ? Number(req.body.progress) : Number(current.progress || 0);
    if (nextProgress < 100) {
      values.push(100);
      updates.push(`progress = $${values.length}`);
    }
  } else if (current.status === 'completed' && incomingStatus !== 'completed') {
    updates.push('completed_at = NULL');
  }

  values.push(nowIso());
  updates.push(`updated_at = $${values.length}`);
  values.push(req.params.id);

  const updated = await pool.query(`UPDATE tasks SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values);

  for (const log of logs) {
    await pool.query(
      `INSERT INTO task_activity_logs (id, task_id, action, old_value, new_value, performed_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId('log_'), req.params.id, `updated_${log.field}`, String(log.oldValue ?? ''), String(log.newValue ?? ''), user.id],
    );
  }

  const next = updated.rows[0];
  if (next.assigned_to !== current.assigned_to) {
    await pool.query(
      `INSERT INTO notifications (id, user_id, title, message)
       VALUES ($1,$2,$3,$4)`,
      [newId('note_'), next.assigned_to, 'Task Reassigned', `${user.name} reassigned you: ${next.title}`],
    );
  } else if (canManageTasks(user) && user.id !== next.assigned_to) {
    await pool.query(
      `INSERT INTO notifications (id, user_id, title, message)
       VALUES ($1,$2,$3,$4)`,
      [newId('note_'), next.assigned_to, 'Task Updated', `${user.name} updated: ${next.title}`],
    );
  }

  await upsertTaskVector(next);

  const enriched = await pool.query(
    `SELECT t.*, au.name AS assigned_to_name, bu.name AS assigned_by_name
     FROM tasks t
     LEFT JOIN users au ON au.id = t.assigned_to
     LEFT JOIN users bu ON bu.id = t.assigned_by
     WHERE t.id = $1`,
    [req.params.id],
  );
  res.json(enriched.rows[0]);
});

app.delete('/api/tasks/:id', requireUser, async (req, res) => {
  if (!canManageTasks(req.currentUser)) return res.status(403).json({ error: 'Only admin, manager, or super admin can delete tasks.' });

  const taskResult = await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
  const task = taskResult.rows[0];
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  await deleteTaskVector(req.params.id);
  await pool.query(
    `INSERT INTO notifications (id, user_id, title, message)
     VALUES ($1,$2,$3,$4)`,
    [newId('note_'), task.assigned_to, 'Task Deleted', `${req.currentUser.name} deleted task: ${task.title}`],
  );

  res.json({ ok: true, deleted_id: req.params.id });
});

app.post('/api/tasks/:id/comments', requireUser, async (req, res) => {
  const user = req.currentUser;
  const comment = String(req.body.comment || '').trim();
  if (!comment) return res.status(400).json({ error: 'Comment is required.' });

  const taskResult = await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
  const task = taskResult.rows[0];
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (user.role === 'employee' && task.assigned_to !== user.id) return res.status(403).json({ error: 'Employees can only comment on their own tasks.' });

  const result = await pool.query(
    `INSERT INTO task_comments (id, task_id, user_id, comment)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [newId('comment_'), req.params.id, user.id, comment],
  );
  await pool.query(
    `INSERT INTO task_activity_logs (id, task_id, action, new_value, performed_by)
     VALUES ($1,$2,'comment_added',$3,$4)`,
    [newId('log_'), req.params.id, comment, user.id],
  );

  if (user.id !== task.assigned_by) {
    await pool.query(
      `INSERT INTO notifications (id, user_id, title, message)
       VALUES ($1,$2,$3,$4)`,
      [newId('note_'), task.assigned_by, 'New Comment', `${user.name} commented on: ${task.title}`],
    );
  }

  res.status(201).json(result.rows[0]);
});

app.get('/api/notifications', requireUser, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 75`,
    [req.currentUser.id],
  );
  res.json(result.rows);
});

app.patch('/api/notifications/:id/read', requireUser, async (req, res) => {
  const result = await pool.query(
    `UPDATE notifications SET is_read = TRUE
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [req.params.id, req.currentUser.id],
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Notification not found.' });
  res.json(result.rows[0]);
});

app.patch('/api/notifications/read-all', requireUser, async (req, res) => {
  await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.currentUser.id]);
  res.json({ ok: true });
});

app.get('/api/stats', requireUser, async (req, res) => {
  const user = req.currentUser;
  const params = [];
  let where = 'WHERE 1=1';
  if (user.role === 'employee') {
    params.push(user.id);
    where += ` AND assigned_to = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'assigned')::int AS assigned,
      COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
      COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
      COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
      COUNT(*) FILTER (WHERE status = 'under_review')::int AS under_review,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'delayed')::int AS delayed,
      COUNT(*) FILTER (WHERE due_date < NOW() AND status <> 'completed')::int AS overdue,
      ROUND(COALESCE(AVG(progress), 0))::int AS average_progress
     FROM tasks ${where}`,
    params,
  );

  const workload = canManageTasks(user)
    ? await pool.query(
        `SELECT u.id, u.name, u.department,
          COUNT(t.id)::int AS total_tasks,
          COUNT(t.id) FILTER (WHERE t.status <> 'completed')::int AS open_tasks,
          COUNT(t.id) FILTER (WHERE t.status = 'blocked')::int AS blocked_tasks,
          COUNT(t.id) FILTER (WHERE t.due_date < NOW() AND t.status <> 'completed')::int AS overdue_tasks,
          ROUND(COALESCE(AVG(t.progress), 0))::int AS average_progress
         FROM users u
         LEFT JOIN tasks t ON t.assigned_to = u.id
         WHERE u.role = 'employee' AND COALESCE(u.is_active, TRUE) = TRUE
         GROUP BY u.id, u.name, u.department
         ORDER BY open_tasks DESC, u.name ASC`,
      )
    : { rows: [] };

  const unread = await pool.query('SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE', [user.id]);
  res.json({ ...result.rows[0], workload: workload.rows, unread_notifications: unread.rows[0]?.count || 0 });
});

app.get('/api/reports/summary', requireUser, async (req, res) => {
  const user = req.currentUser;
  const params = [];
  let where = 'WHERE 1=1';
  if (user.role === 'employee') {
    params.push(user.id);
    where += ` AND t.assigned_to = $${params.length}`;
  }

  const byStatus = await pool.query(`SELECT status, COUNT(*)::int AS count FROM tasks t ${where} GROUP BY status ORDER BY status`, params);
  const byPriority = await pool.query(`SELECT priority, COUNT(*)::int AS count FROM tasks t ${where} GROUP BY priority ORDER BY priority`, params);
  const overdue = await pool.query(`SELECT COUNT(*)::int AS count FROM tasks t ${where} AND t.due_date < NOW() AND t.status <> 'completed'`, params);
  res.json({ by_status: byStatus.rows, by_priority: byPriority.rows, overdue: overdue.rows[0]?.count || 0 });
});

app.get('/api/search', requireUser, async (req, res) => {
  const query = String(req.query.q || '').trim();
  const user = req.currentUser;
  if (!query) return res.json([]);

  try {
    const matches = await searchQdrant(query, user);
    const taskIds = matches.map((item) => item?.payload?.task_id).filter(Boolean);
    if (!taskIds.length) return res.json([]);

    const result = await pool.query(
      `SELECT t.*, au.name AS assigned_to_name, bu.name AS assigned_by_name
       FROM tasks t
       LEFT JOIN users au ON au.id = t.assigned_to
       LEFT JOIN users bu ON bu.id = t.assigned_by
       WHERE t.id = ANY($1::text[])`,
      [taskIds],
    );

    const byId = new Map(result.rows.map((row) => [row.id, row]));
    const ordered = taskIds.map((id, index) => ({ ...byId.get(id), score: matches[index]?.score })).filter((row) => row.id);
    return res.json(ordered);
  } catch (error) {
    console.warn('Qdrant search fallback:', error.message);
    const params = [`%${query.toLowerCase()}%`];
    let where = 'WHERE (LOWER(t.title) LIKE $1 OR LOWER(COALESCE(t.description,\'\')) LIKE $1)';
    if (user.role === 'employee') {
      params.push(user.id);
      where += ` AND t.assigned_to = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT t.*, au.name AS assigned_to_name, bu.name AS assigned_by_name
       FROM tasks t
       LEFT JOIN users au ON au.id = t.assigned_to
       LEFT JOIN users bu ON bu.id = t.assigned_by
       ${where}
       ORDER BY t.updated_at DESC
       LIMIT 12`,
      params,
    );
    return res.json(result.rows.map((row) => ({ ...row, score: null })));
  }
});

app.post('/api/admin/reindex', requireUser, async (req, res) => {
  if (!canManageTasks(req.currentUser)) return res.status(403).json({ error: 'Only managers can reindex.' });
  await ensureQdrantCollection();
  await reindexAllTasks();
  res.json({ ok: true, message: 'All tasks reindexed in Qdrant.' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  try {
    await ensureAppReady();
    app.listen(PORT, () => {
      console.log(`FlowDesk running on http://localhost:${PORT}`);
      console.log(`Qdrant URL: ${QDRANT_URL}`);
    });
  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
}

if (require.main === module && !process.env.VERCEL) {
  start();
}

module.exports = app;
