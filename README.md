# FlowDesk Task Manager — Vercel Ready

Premium employee task-management dashboard with:

- Email/password login
- Admin/manager dashboard
- Employee-only task visibility
- Employee management from dashboard
- Add/edit/deactivate employee from dashboard
- Password setup/reset from dashboard
- Voice/text task assignment
- Task status/progress/comments/activity
- Mobile-responsive layout
- PostgreSQL for business data
- Qdrant for smart semantic task search
- Vercel-compatible Express export

---

## 1. Run locally

```bash
npm install
cp .env.example .env
```

Start PostgreSQL and Qdrant locally:

```bash
docker compose up -d postgres qdrant
```

Run app:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

---

## 2. Demo credentials

| Role | Email | Password |
|---|---|---|
| Super Admin | anil@hca.local | Admin@123 |
| Admin | bhavya@hca.local | Admin@123 |
| Manager | neha@hca.local | Admin@123 |
| Employee | rahul@hca.local | Employee@123 |
| Employee | priya@hca.local | Employee@123 |
| Employee | amit@hca.local | Employee@123 |
| Employee | vashu@hca.local | Employee@123 |

---

## 3. Deploy on Vercel

### Important

Vercel will host the web app and Express API, but it will not run your local Docker containers in production. For production deployment, use:

- Hosted PostgreSQL: Neon, Supabase, or Vercel Marketplace Postgres provider
- Hosted Qdrant: Qdrant Cloud or your own public VPS Qdrant URL

### Required Vercel Environment Variables

Add these in Vercel Project Settings → Environment Variables:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require
QDRANT_URL=https://your-qdrant-cloud-url
QDRANT_COLLECTION=tasks_vectors
VECTOR_SIZE=384
SKIP_QDRANT_REINDEX=false
```

If you are not using Qdrant in production yet, leave `QDRANT_URL` empty or set it later. The app will still work with PostgreSQL; Qdrant search will gracefully fallback to normal text search.

### Vercel deployment steps

```bash
npm install -g vercel
vercel login
vercel
vercel --prod
```

Or push this folder to GitHub and import the repository in Vercel.

---

## 4. Add a new employee

1. Login as Admin or Manager.
2. Open **Employees** from the sidebar.
3. Enter name, email, password, role, and department.
4. Click **Save Employee**.
5. The new employee can login using that email/password.
6. The employee will appear automatically in the Assign Task dropdown.

---

## 5. Reset employee password

1. Login as Admin or Manager.
2. Open **Employees**.
3. Click **Edit** for the employee.
4. Enter a new password.
5. Click **Save Employee**.

If the password field is blank while editing, the existing password remains unchanged.

---

## 6. Employee privacy logic

Employees can only view and update tasks assigned to them.

Admins/managers can:

- Create tasks
- Edit/reassign tasks
- Add employees
- Reset employee passwords
- View reports
- View all team tasks

---

## 7. Notes for Vercel

This project exports the Express app from `server.js`, which is required for Vercel deployment. Local development still runs using `node server.js`.

The `public` folder contains the frontend UI. Vercel serves files in `public` as static assets, while API routes are handled by the Express app.
