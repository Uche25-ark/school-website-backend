import 'dotenv/config'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { MongoClient } from 'mongodb'

const PORT = Number(process.env.PORT || 3001)
const MONGODB_URI = process.env.MONGODB_URI
const MONGODB_DB = process.env.MONGODB_DB || 'school_website'
const LEGACY_DATA_FILE = fileURLToPath(new URL('./data.json', import.meta.url))
const DIST_DIR = fileURLToPath(new URL('../frontend/dist/', import.meta.url))
const sessions = new Map()
const ROLES = ['admin', 'teacher', 'student']
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex')
}

function makeUser({ name, email, password, role, className = '', subject = '' }) {
  const salt = randomBytes(16).toString('hex')
  return {
    id: randomBytes(8).toString('hex'),
    name,
    email,
    role,
    className,
    subject,
    salt,
    passwordHash: hashPassword(password, salt),
  }
}

function seedData() {
  const users = [
    makeUser({ name: 'School Administrator', email: 'admin@school.test', password: 'Admin123!', role: 'admin' }),
    makeUser({ name: 'Alex Morgan', email: 'teacher@school.test', password: 'Teacher123!', role: 'teacher', className: 'Year 10', subject: 'English' }),
    makeUser({ name: 'Jamie Carter', email: 'student@school.test', password: 'Student123!', role: 'student', className: 'Year 10' }),
    makeUser({ name: 'Taylor Brooks', email: 'taylor@school.test', password: 'Student123!', role: 'student', className: 'Year 10' }),
    makeUser({ name: 'Morgan Lee', email: 'morgan@school.test', password: 'Student123!', role: 'student', className: 'Year 10' }),
  ]
  return {
    users,
    attendance: [],
    assignments: [
      {
        id: randomBytes(8).toString('hex'),
        title: 'Reading response: A Christmas Carol',
        description: 'Read chapters 1–2 and write a short response about how Scrooge is introduced.',
        className: 'Year 10',
        dueDate: '2026-12-01',
        createdBy: users[1].id,
      },
    ],
    exams: [
      {
        id: randomBytes(8).toString('hex'),
        title: 'English literature check-in',
        className: 'Year 10',
        questions: [
          { id: 'q1', text: 'Who wrote A Christmas Carol?', options: ['Charles Dickens', 'Jane Austen', 'William Shakespeare'], correctIndex: 0 },
          { id: 'q2', text: 'What is the name of Scrooge’s clerk?', options: ['Fred', 'Bob Cratchit', 'Jacob Marley'], correctIndex: 1 },
        ],
        createdBy: users[1].id,
      },
    ],
    results: [],
    reportCards: [],
    assessments: [],
    assessmentRecords: [],
    assignmentAttempts: [],
    examAttempts: [],
    assignmentSubmissions: [],
  }
}

let data
let saveQueue = Promise.resolve()
let portalCollection
let sessionCollection
let lockCollection
let connectPromise

async function saveData() {
  const nextSave = saveQueue.then(async () => {
    await portalCollection.replaceOne(
      { _id: 'school-portal' },
      { _id: 'school-portal', ...data },
      { upsert: true },
    )
  })
  saveQueue = nextSave.catch((error) => {
    saveQueue = Promise.resolve()
    throw error
  })
  return saveQueue
}

async function loadData() {
  const storedState = await portalCollection.findOne({ _id: 'school-portal' })
  let needsSave = !storedState

  if (storedState) {
    const { _id, ...storedData } = storedState
    data = storedData
  } else {
    try {
      data = JSON.parse(await readFile(LEGACY_DATA_FILE, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      data = seedData()
    }
  }

  for (const key of ['reportCards', 'assessments', 'assessmentRecords', 'assignmentAttempts', 'examAttempts', 'assignmentSubmissions']) {
    if (data[key] === undefined) {
      data[key] = []
      needsSave = true
    }
  }

  const legacyActivityDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  for (const assignment of data.assignments) {
    if (!Number.isFinite(Date.parse(assignment.dueDate))) {
      assignment.dueDate = legacyActivityDeadline
      needsSave = true
    }
    if (assignment.questions?.length && (!Number.isInteger(Number(assignment.durationMinutes)) || Number(assignment.durationMinutes) < 1)) {
      assignment.durationMinutes = 30
      needsSave = true
    }
  }

  for (const exam of data.exams) {
    if (!Number.isFinite(Date.parse(exam.dueDate))) {
      exam.dueDate = legacyActivityDeadline
      needsSave = true
    }
    if (!Number.isInteger(Number(exam.durationMinutes)) || Number(exam.durationMinutes) < 1) {
      exam.durationMinutes = 30
      needsSave = true
    }
  }

  for (const attempt of [...data.assignmentAttempts, ...data.examAttempts]) {
    if (attempt.answers === undefined) {
      attempt.answers = {}
      needsSave = true
    }
  }

  if (data.users.some((user) => user.subject === undefined) || data.exams.some((exam) => exam.subject === undefined)) {
    data.users = data.users.map((user) => ({
      subject: user.email?.toLowerCase() === 'teacher@school.test' ? 'English' : '',
      ...user,
    }))
    data.exams = data.exams.map((exam) => ({ subject: '', ...exam }))
    needsSave = true
  }

  if (needsSave) await saveData()
}

async function connectDatabase() {
  if (portalCollection) return
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is required. Add your MongoDB connection string to the .env file.')
  }
  if (!connectPromise) {
    connectPromise = (async () => {
      const client = new MongoClient(MONGODB_URI)
      await client.connect()
      const database = client.db(MONGODB_DB)
      portalCollection = database.collection('portal_state')
      sessionCollection = database.collection('portal_sessions')
      lockCollection = database.collection('portal_locks')
    })()
  }
  try {
    await connectPromise
  } catch (error) {
    connectPromise = null
    throw error
  }
}

function getSessionToken(request) {
  return request.headers.authorization?.replace(/^Bearer\s+/i, '')
}

function getSessionKey(token) {
  return createHash('sha256').update(token).digest('hex')
}

async function hydrateSession(request) {
  const token = getSessionToken(request)
  if (!token) return
  const session = await sessionCollection.findOne({ _id: getSessionKey(token) })
  if (session) sessions.set(token, session.userId)
  else sessions.delete(token)
}

async function withPortalLock(callback) {
  try {
    await lockCollection.insertOne({ _id: 'school-portal', owner: '', expiresAt: new Date(0) })
  } catch (error) {
    if (error.code !== 11000) throw error
  }

  const owner = randomBytes(16).toString('hex')
  const waitUntil = Date.now() + 7000
  let acquired = false
  while (!acquired && Date.now() < waitUntil) {
    const now = new Date()
    const result = await lockCollection.updateOne(
      { _id: 'school-portal', $or: [{ expiresAt: { $lte: now } }, { owner }] },
      { $set: { owner, expiresAt: new Date(now.getTime() + 60_000) } },
    )
    acquired = result.modifiedCount === 1
    if (!acquired) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!acquired) throw new ApiError(503, 'The portal is busy. Please retry your request.')

  const renewer = setInterval(() => {
    lockCollection.updateOne(
      { _id: 'school-portal', owner },
      { $set: { expiresAt: new Date(Date.now() + 60_000) } },
    ).catch((error) => console.error('Unable to renew the portal request lock:', error))
  }, 20_000)

  try {
    return await callback()
  } finally {
    clearInterval(renewer)
    await lockCollection.updateOne(
      { _id: 'school-portal', owner },
      { $set: { owner: '', expiresAt: new Date(0) } },
    )
  }
}

class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function publicUser(user) {
  const safeUser = { ...user }
  delete safeUser.salt
  delete safeUser.passwordHash
  return safeUser
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

async function readJson(request) {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > 1_000_000) throw new ApiError(413, 'Request is too large.')
  }
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON.')
  }
}

function requireUser(request, roles = ROLES) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  const userId = token && sessions.get(token)
  const user = data.users.find((item) => item.id === userId)
  if (!user || !roles.includes(user.role)) throw new ApiError(401, 'Please sign in with an account that has access.')
  return user
}

function requireText(value, label, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new ApiError(400, `${label} is required and must be ${maxLength} characters or fewer.`)
  }
  return value.trim()
}

function assignedClass(user, requestedClass) {
  const className = requestedClass ? requireText(requestedClass, 'Class', 60) : user.className
  if (!className) throw new ApiError(400, 'Assign a class to this account first.')
  if (user.role === 'teacher' && user.className && className !== user.className) {
    throw new ApiError(403, 'You can only manage your assigned class.')
  }
  return className
}

function assignedSubject(user, requestedSubject) {
  const subject = requestedSubject ? requireText(requestedSubject, 'Subject', 80) : user.subject
  if (!subject) throw new ApiError(400, 'Assign a subject to this teacher first.')
  if (user.role === 'teacher' && user.subject && subject.toLowerCase() !== user.subject.toLowerCase()) {
    throw new ApiError(403, 'You can only manage your assigned subject.')
  }
  return subject
}

function parseQuestions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new ApiError(400, 'Add between 1 and 50 questions.')
  }
  return value.map((question, index) => {
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 6) {
      throw new ApiError(400, `Question ${index + 1} needs between 2 and 6 answer options.`)
    }
    const correctIndex = Number(question.correctIndex)
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= question.options.length) {
      throw new ApiError(400, `Choose the correct answer for question ${index + 1}.`)
    }
    return {
      id: randomBytes(6).toString('hex'),
      text: requireText(question.text, `Question ${index + 1}`, 500),
      options: question.options.map((option) => requireText(option, 'Answer option', 200)),
      correctIndex,
    }
  })
}

function normalizeAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return {}
  return Object.fromEntries(questions.flatMap((question) => {
    const answer = Number(answers[question.id])
    return Number.isInteger(answer) && answer >= 0 && answer < question.options.length
      ? [[question.id, answer]]
      : []
  }))
}

function calculateScore(questions, answers) {
  return questions.reduce((score, question) => score + (answers[question.id] === question.correctIndex ? 1 : 0), 0)
}

function finishAssignment(assignment, student, attempt, answers, submittedAt, missed = false) {
  const existing = data.assignmentSubmissions.find((item) => item.assignmentId === assignment.id && item.studentId === student.id)
  if (existing) return existing

  const questions = assignment.questions || []
  const validAnswers = normalizeAnswers(questions, answers)
  const submission = {
    id: randomBytes(8).toString('hex'),
    assignmentId: assignment.id,
    assignmentTitle: assignment.title,
    studentId: student.id,
    studentName: student.name,
    className: student.className,
    subject: assignment.subject,
    score: calculateScore(questions, validAnswers),
    total: questions.length,
    submittedAt: new Date(submittedAt).toISOString(),
    teacherFeedback: '',
    missed,
  }
  data.assignmentSubmissions.push(submission)
  if (attempt) {
    attempt.answers = validAnswers
    attempt.completedAt = submission.submittedAt
  }
  return submission
}

function finishExam(exam, student, attempt, answers, submittedAt, missed = false) {
  const existing = data.results.find((item) => item.examId === exam.id && item.studentId === student.id)
  if (existing) return existing

  const validAnswers = normalizeAnswers(exam.questions, answers)
  const result = {
    id: randomBytes(8).toString('hex'),
    studentId: student.id,
    studentName: student.name,
    className: student.className,
    examId: exam.id,
    examTitle: exam.title,
    subject: exam.subject,
    score: calculateScore(exam.questions, validAnswers),
    total: exam.questions.length,
    submittedAt: new Date(submittedAt).toISOString(),
    teacherFeedback: '',
    missed,
  }
  data.results.push(result)
  if (attempt) {
    attempt.answers = validAnswers
    attempt.completedAt = result.submittedAt
  }
  return result
}

async function finalizeExpiredActivities(now = Date.now()) {
  let changed = false

  for (const attempt of data.assignmentAttempts) {
    if (data.assignmentSubmissions.some((item) => item.assignmentId === attempt.assignmentId && item.studentId === attempt.studentId)) continue
    const assignment = data.assignments.find((item) => item.id === attempt.assignmentId)
    const student = data.users.find((item) => item.id === attempt.studentId)
    if (!assignment?.questions?.length || !student) continue
    const deadline = Date.parse(assignment.dueDate)
    const startedAt = Date.parse(attempt.startedAt)
    const duration = Number(assignment.durationMinutes) || 30
    const cutoff = Math.min(deadline, startedAt + duration * 60_000)
    if (Number.isFinite(cutoff) && cutoff <= now) {
      finishAssignment(assignment, student, attempt, attempt.answers, cutoff)
      changed = true
    }
  }

  for (const attempt of data.examAttempts) {
    if (data.results.some((item) => item.examId === attempt.examId && item.studentId === attempt.studentId)) continue
    const exam = data.exams.find((item) => item.id === attempt.examId)
    const student = data.users.find((item) => item.id === attempt.studentId)
    if (!exam || !student) continue
    const deadline = Date.parse(exam.dueDate)
    const startedAt = Date.parse(attempt.startedAt)
    const cutoff = Math.min(deadline, startedAt + Number(exam.durationMinutes) * 60_000)
    if (Number.isFinite(cutoff) && cutoff <= now) {
      finishExam(exam, student, attempt, attempt.answers, cutoff)
      changed = true
    }
  }

  for (const assignment of data.assignments) {
    if (!assignment.questions?.length) continue
    const deadline = Date.parse(assignment.dueDate)
    if (!Number.isFinite(deadline) || deadline > now) continue
    const students = data.users.filter((item) => item.role === 'student' && item.className === assignment.className)
    for (const student of students) {
      if (data.assignmentSubmissions.some((item) => item.assignmentId === assignment.id && item.studentId === student.id)) continue
      const attempt = data.assignmentAttempts.find((item) => item.assignmentId === assignment.id && item.studentId === student.id)
      finishAssignment(assignment, student, attempt, attempt?.answers, deadline, !attempt)
      changed = true
    }
  }

  for (const exam of data.exams) {
    const deadline = Date.parse(exam.dueDate)
    if (!Number.isFinite(deadline) || deadline > now) continue
    const students = data.users.filter((item) => item.role === 'student' && item.className === exam.className)
    for (const student of students) {
      if (data.results.some((item) => item.examId === exam.id && item.studentId === student.id)) continue
      const attempt = data.examAttempts.find((item) => item.examId === exam.id && item.studentId === student.id)
      finishExam(exam, student, attempt, attempt?.answers, deadline, !attempt)
      changed = true
    }
  }

  if (changed) await saveData()
}

async function handleApi(request, response, url) {
  if (request.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(request)
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const user = data.users.find((item) => item.email.toLowerCase() === email)
    if (!user || !timingSafeEqual(Buffer.from(hashPassword(password, user.salt)), Buffer.from(user.passwordHash))) {
      throw new ApiError(401, 'Email or password is incorrect.')
    }
    const token = randomBytes(32).toString('hex')
    sessions.set(token, user.id)
    await sessionCollection.insertOne({ _id: getSessionKey(token), userId: user.id })
    return sendJson(response, 200, { token, user: publicUser(user) })
  }

  if (request.method === 'POST' && url.pathname === '/api/logout') {
    const token = getSessionToken(request)
    const userId = token && sessions.get(token)
    const student = data.users.find((item) => item.id === userId && item.role === 'student')
    let changed = false
    if (student) {
      const now = Date.now()
      for (const attempt of data.assignmentAttempts.filter((item) => item.studentId === student.id)) {
        const assignment = data.assignments.find((item) => item.id === attempt.assignmentId)
        if (!assignment?.questions?.length || data.assignmentSubmissions.some((item) => item.assignmentId === assignment.id && item.studentId === student.id)) continue
        const cutoff = Math.min(
          Date.parse(assignment.dueDate),
          Date.parse(attempt.startedAt) + (Number(assignment.durationMinutes) || 30) * 60_000,
        )
        if (!Number.isFinite(cutoff)) continue
        finishAssignment(assignment, student, attempt, attempt.answers, Math.min(now, cutoff))
        changed = true
      }
      for (const attempt of data.examAttempts.filter((item) => item.studentId === student.id)) {
        const exam = data.exams.find((item) => item.id === attempt.examId)
        if (!exam || data.results.some((item) => item.examId === exam.id && item.studentId === student.id)) continue
        const cutoff = Math.min(
          Date.parse(exam.dueDate),
          Date.parse(attempt.startedAt) + Number(exam.durationMinutes) * 60_000,
        )
        if (!Number.isFinite(cutoff)) continue
        finishExam(exam, student, attempt, attempt.answers, Math.min(now, cutoff))
        changed = true
      }
    }
    if (changed) await saveData()
    if (token) {
      sessions.delete(token)
      await sessionCollection.deleteOne({ _id: getSessionKey(token) })
    }
    return sendJson(response, 200, { ok: true })
  }

  if (request.method === 'POST' && url.pathname === '/api/account/password') {
    const user = requireUser(request, ['teacher', 'student'])
    const body = await readJson(request)
    if (typeof body.currentPassword !== 'string' || body.currentPassword.length < 1 || body.currentPassword.length > 100) {
      throw new ApiError(400, 'Enter your current password.')
    }
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 8 || body.newPassword.length > 100) {
      throw new ApiError(400, 'New password must be between 8 and 100 characters.')
    }
    if (!timingSafeEqual(Buffer.from(hashPassword(body.currentPassword, user.salt)), Buffer.from(user.passwordHash))) {
      throw new ApiError(401, 'Current password is incorrect.')
    }
    if (body.newPassword === body.currentPassword) {
      throw new ApiError(400, 'Choose a new password that is different from your current password.')
    }

    const token = getSessionToken(request)
    const salt = randomBytes(16).toString('hex')
    user.salt = salt
    user.passwordHash = hashPassword(body.newPassword, salt)
    await saveData()
    await sessionCollection.deleteMany({ userId: user.id, _id: { $ne: getSessionKey(token) } })
    for (const [session, userId] of sessions) {
      if (userId === user.id && session !== token) sessions.delete(session)
    }
    return sendJson(response, 200, { ok: true })
  }

  if (request.method === 'GET' && url.pathname === '/api/portal') {
    await finalizeExpiredActivities()
    const user = requireUser(request)
    const students = data.users.filter((item) => item.role === 'student' && (user.role === 'admin' || item.className === user.className))
    return sendJson(response, 200, {
      user: publicUser(user),
      users: user.role === 'admin' ? data.users.map(publicUser) : [],
      students: user.role === 'student' ? [] : students.map(publicUser),
      assignments: (user.role === 'student' ? data.assignments.filter((item) => item.className === user.className) : data.assignments)
        .map((assignment) => ({
          ...assignment,
          questionCount: (assignment.questions || []).length,
          questions: user.role === 'student' ? [] : (assignment.questions || []).map(({ id, text, options }) => ({ id, text, options })),
        })),
      exams: data.exams
        .filter((item) => user.role === 'admin' || item.className === user.className)
        .map((exam) => ({
          ...exam,
          questionCount: exam.questions.length,
          questions: user.role === 'student' ? [] : exam.questions.map(({ id, text, options }) => ({ id, text, options })),
        })),
      examAttempts: data.examAttempts.filter((item) => user.role === 'student' && item.studentId === user.id),
      attendance: data.attendance.filter((item) => user.role === 'admin' || item.className === user.className),
      results: data.results.filter((item) => user.role === 'admin' || (user.role === 'teacher' ? item.className === user.className : item.studentId === user.id)),
      reportCards: data.reportCards.filter((item) => user.role === 'admin' || (user.role === 'teacher' ? item.className === user.className : item.studentId === user.id)),
      assessments: data.assessments.filter((item) => user.role === 'admin' || item.className === user.className),
      assessmentRecords: data.assessmentRecords.filter((item) => user.role === 'admin' || (user.role === 'teacher' ? item.className === user.className : item.studentId === user.id)),
      assignmentAttempts: data.assignmentAttempts.filter((item) => user.role === 'student' && item.studentId === user.id),
      assignmentSubmissions: data.assignmentSubmissions.filter((item) => user.role === 'admin' || (user.role === 'teacher' ? item.className === user.className : item.studentId === user.id)),
    })
  }

  if (request.method === 'POST' && url.pathname === '/api/users') {
    requireUser(request, ['admin'])
    const body = await readJson(request)
    const name = requireText(body.name, 'Name')
    const email = requireText(body.email, 'Email', 254).toLowerCase()
    const password = requireText(body.password, 'Password', 100)
    const role = ROLES.includes(body.role) && body.role !== 'admin' ? body.role : null
    if (!role) throw new ApiError(400, 'Choose teacher or student as the account role.')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'Enter a valid email address.')
    if (password.length < 8) throw new ApiError(400, 'Password must be at least 8 characters long.')
    if (data.users.some((item) => item.email.toLowerCase() === email)) throw new ApiError(409, 'An account with that email already exists.')
    const className = typeof body.className === 'string' ? body.className.trim().slice(0, 60) : ''
    const subject = role === 'teacher' ? requireText(body.subject, 'Teaching subject', 80) : ''
    if (role === 'teacher' && !className) throw new ApiError(400, 'Assign a class to this teacher.')
    const user = makeUser({ name, email, password, role, className, subject })
    data.users.push(user)
    await saveData()
    return sendJson(response, 201, { user: publicUser(user) })
  }

  const deleteUserMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/)
  if (request.method === 'DELETE' && deleteUserMatch) {
    const admin = requireUser(request, ['admin'])
    const userId = decodeURIComponent(deleteUserMatch[1])
    if (userId === admin.id) throw new ApiError(400, 'You cannot delete the account you are currently using.')
    const userIndex = data.users.findIndex((item) => item.id === userId)
    if (userIndex < 0) throw new ApiError(404, 'User account not found.')
    data.users.splice(userIndex, 1)
    for (const [session, sessionUserId] of sessions) {
      if (sessionUserId === userId) sessions.delete(session)
    }
    await sessionCollection.deleteMany({ userId })
    await saveData()
    return sendJson(response, 200, { ok: true })
  }

  if (request.method === 'POST' && url.pathname === '/api/attendance') {
    const teacher = requireUser(request, ['admin', 'teacher'])
    const body = await readJson(request)
    const className = assignedClass(teacher, body.className)
    const date = requireText(body.date, 'Date', 10)
    if (!Array.isArray(body.entries) || body.entries.length > 500) throw new ApiError(400, 'Attendance entries are invalid.')
    for (const entry of body.entries) {
      if (typeof entry.studentId !== 'string' || typeof entry.present !== 'boolean') throw new ApiError(400, 'Each attendance entry needs a student and present/absent status.')
      const student = data.users.find((item) => item.id === entry.studentId && item.role === 'student' && item.className === className)
      if (!student) throw new ApiError(400, 'An attendance entry does not belong to this class.')
      data.attendance = data.attendance.filter((record) => !(record.studentId === student.id && record.date === date))
      data.attendance.push({ studentId: student.id, studentName: student.name, className, date, present: entry.present, recordedBy: teacher.id })
    }
    await saveData()
    return sendJson(response, 201, { ok: true })
  }

  if (request.method === 'POST' && url.pathname === '/api/assignments') {
    const teacher = requireUser(request, ['admin', 'teacher'])
    const body = await readJson(request)
    const assignment = {
      id: randomBytes(8).toString('hex'),
      title: requireText(body.title, 'Title'),
      description: requireText(body.description, 'Description', 2000),
      className: assignedClass(teacher, body.className),
      subject: assignedSubject(teacher, body.subject),
      dueDate: requireText(body.dueDate, 'Due date', 30),
      durationMinutes: Number(body.durationMinutes),
      questions: parseQuestions(body.questions),
      createdBy: teacher.id,
    }
    if (!Number.isInteger(assignment.durationMinutes) || assignment.durationMinutes < 1 || assignment.durationMinutes > 240) {
      throw new ApiError(400, 'Assignment time limit must be between 1 and 240 minutes.')
    }
    const dueAt = Date.parse(assignment.dueDate)
    if (!Number.isFinite(dueAt)) throw new ApiError(400, 'Enter a valid due date and time.')
    if (dueAt <= Date.now()) throw new ApiError(400, 'The assignment deadline must be in the future.')
    data.assignments.unshift(assignment)
    await saveData()
    return sendJson(response, 201, { assignment: { ...assignment, questions: assignment.questions.map(({ id, text, options }) => ({ id, text, options })) } })
  }

  const startAssignmentMatch = url.pathname.match(/^\/api\/assignments\/([^/]+)\/start$/)
  if (request.method === 'POST' && startAssignmentMatch) {
    const student = requireUser(request, ['student'])
    const assignment = data.assignments.find((item) => item.id === startAssignmentMatch[1] && item.className === student.className)
    if (!assignment) throw new ApiError(404, 'Assignment not found for your class.')
    if (!assignment.questions?.length) throw new ApiError(400, 'This assignment does not contain timed questions.')
    const deadline = Date.parse(assignment.dueDate)
    if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new ApiError(410, 'This assignment is past its deadline.')
    if (data.assignmentSubmissions.some((item) => item.assignmentId === assignment.id && item.studentId === student.id)) {
      throw new ApiError(409, 'You have already submitted this assignment.')
    }
    if (data.assignmentAttempts.some((item) => item.assignmentId === assignment.id && item.studentId === student.id)) {
      throw new ApiError(409, 'This assignment attempt has already started and cannot be resumed.')
    }
    const attempt = { id: randomBytes(8).toString('hex'), assignmentId: assignment.id, studentId: student.id, startedAt: new Date().toISOString(), answers: {} }
    data.assignmentAttempts.push(attempt)
    await saveData()
    return sendJson(response, 200, { attempt, assignment: { ...assignment, questions: assignment.questions.map(({ id, text, options }) => ({ id, text, options })) } })
  }

  const assignmentAnswersMatch = url.pathname.match(/^\/api\/assignments\/([^/]+)\/answers$/)
  if (request.method === 'POST' && assignmentAnswersMatch) {
    const student = requireUser(request, ['student'])
    const assignment = data.assignments.find((item) => item.id === assignmentAnswersMatch[1] && item.className === student.className)
    if (!assignment) throw new ApiError(404, 'Assignment not found for your class.')
    const attempt = data.assignmentAttempts.find((item) => item.assignmentId === assignment.id && item.studentId === student.id)
    if (!attempt) throw new ApiError(400, 'Start the assignment before saving answers.')
    const existing = data.assignmentSubmissions.find((item) => item.assignmentId === assignment.id && item.studentId === student.id)
    if (existing) return sendJson(response, 200, { ok: true, submitted: true })
    const cutoff = Math.min(
      Date.parse(assignment.dueDate),
      Date.parse(attempt.startedAt) + (Number(assignment.durationMinutes) || 30) * 60_000,
    )
    if (!Number.isFinite(cutoff)) throw new ApiError(400, 'The assignment deadline or attempt time is invalid.')
    const requestReceivedAt = Date.now()
    const body = await readJson(request)
    if (requestReceivedAt >= cutoff) {
      const submission = finishAssignment(assignment, student, attempt, attempt.answers, cutoff)
      await saveData()
      return sendJson(response, 200, { ok: true, submission })
    }
    attempt.answers = normalizeAnswers(assignment.questions || [], body.answers)
    await saveData()
    return sendJson(response, 200, { ok: true })
  }

  const submitAssignmentMatch = url.pathname.match(/^\/api\/assignments\/([^/]+)\/submit$/)
  if (request.method === 'POST' && submitAssignmentMatch) {
    const student = requireUser(request, ['student'])
    const assignment = data.assignments.find((item) => item.id === submitAssignmentMatch[1] && item.className === student.className)
    if (!assignment) throw new ApiError(404, 'Assignment not found for your class.')
    const existing = data.assignmentSubmissions.find((item) => item.assignmentId === assignment.id && item.studentId === student.id)
    if (existing) return sendJson(response, 200, { submission: existing, alreadySubmitted: true })
    const attempt = data.assignmentAttempts.find((item) => item.assignmentId === assignment.id && item.studentId === student.id)
    if (!attempt) throw new ApiError(400, 'Start the assignment before submitting it.')
    const submittedAt = Date.now()
    const body = await readJson(request)
    const cutoff = Math.min(
      Date.parse(assignment.dueDate),
      Date.parse(attempt.startedAt) + (Number(assignment.durationMinutes) || 30) * 60_000,
    )
    if (!Number.isFinite(cutoff)) throw new ApiError(400, 'The assignment deadline or attempt time is invalid.')
    const answers = submittedAt >= cutoff
      ? attempt.answers
      : normalizeAnswers(assignment.questions || [], body.answers ?? attempt.answers)
    const submission = finishAssignment(assignment, student, attempt, answers, Math.min(submittedAt, cutoff))
    await saveData()
    return sendJson(response, 201, { submission })
  }

  if (request.method === 'POST' && url.pathname === '/api/assessments') {
    const teacher = requireUser(request, ['admin', 'teacher'])
    const body = await readJson(request)
    const assessment = {
      id: randomBytes(8).toString('hex'),
      title: requireText(body.title, 'Assessment title'),
      subject: assignedSubject(teacher, body.subject),
      category: requireText(body.category, 'Assessment type', 60),
      className: assignedClass(teacher, body.className),
      maxScore: Number(body.maxScore),
      date: requireText(body.date, 'Assessment date', 10),
      createdBy: teacher.id,
      createdAt: new Date().toISOString(),
    }
    if (!Number.isFinite(assessment.maxScore) || assessment.maxScore <= 0 || assessment.maxScore > 1000) {
      throw new ApiError(400, 'Maximum score must be greater than 0 and no more than 1000.')
    }
    if (Number.isNaN(Date.parse(assessment.date))) throw new ApiError(400, 'Enter a valid assessment date.')
    data.assessments.unshift(assessment)
    await saveData()
    return sendJson(response, 201, { assessment })
  }

  const assessmentRecordsMatch = url.pathname.match(/^\/api\/assessments\/([^/]+)\/records$/)
  if (request.method === 'POST' && assessmentRecordsMatch) {
    const teacher = requireUser(request, ['admin', 'teacher'])
    const assessment = data.assessments.find((item) => item.id === assessmentRecordsMatch[1])
    if (!assessment) throw new ApiError(404, 'Assessment not found.')
    if ((teacher.role === 'teacher' && assessment.className !== teacher.className) ||
      (teacher.role === 'teacher' && teacher.subject && assessment.subject.toLowerCase() !== teacher.subject.toLowerCase())) {
      throw new ApiError(403, 'You can only record marks for your assigned class and subject.')
    }
    const body = await readJson(request)
    if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 500) {
      throw new ApiError(400, 'Add at least one student mark.')
    }
    for (const entry of body.records) {
      const student = data.users.find((item) => item.id === entry.studentId && item.role === 'student' && item.className === assessment.className)
      const score = Number(entry.score)
      if (!student || !Number.isFinite(score) || score < 0 || score > assessment.maxScore) {
        throw new ApiError(400, 'Each mark must belong to a student in this class and be within the maximum score.')
      }
      const record = {
        id: randomBytes(8).toString('hex'),
        assessmentId: assessment.id,
        assessmentTitle: assessment.title,
        studentId: student.id,
        studentName: student.name,
        className: assessment.className,
        subject: assessment.subject,
        category: assessment.category,
        score,
        maxScore: assessment.maxScore,
        feedback: typeof entry.feedback === 'string' ? entry.feedback.trim().slice(0, 1000) : '',
        releasedAt: new Date().toISOString(),
        recordedBy: teacher.id,
      }
      data.assessmentRecords = data.assessmentRecords.filter((item) => !(item.assessmentId === assessment.id && item.studentId === student.id))
      data.assessmentRecords.push(record)
    }
    await saveData()
    return sendJson(response, 200, { ok: true })
  }

  const resultFeedbackMatch = url.pathname.match(/^\/api\/results\/([^/]+)\/feedback$/)
  if (request.method === 'POST' && resultFeedbackMatch) {
    const teacher = requireUser(request, ['admin', 'teacher'])
    const body = await readJson(request)
    const feedback = requireText(body.feedback, 'Feedback', 1000)
    const result = data.results.find((item) => item.id === resultFeedbackMatch[1])
    const assignmentSubmission = data.assignmentSubmissions.find((item) => item.id === resultFeedbackMatch[1])
    const record = result || assignmentSubmission
    if (!record) throw new ApiError(404, 'Student result not found.')
    if (teacher.role === 'teacher' && (record.className !== teacher.className ||
      (teacher.subject && record.subject && record.subject.toLowerCase() !== teacher.subject.toLowerCase()))) {
      throw new ApiError(403, 'You can only review results for your assigned class and subject.')
    }
    record.teacherFeedback = feedback
    record.reviewedAt = new Date().toISOString()
    await saveData()
    return sendJson(response, 200, { ok: true })
  }

  if (request.method === 'POST' && url.pathname === '/api/report-cards') {
    const teacher = requireUser(request, ['admin', 'teacher'])
    const body = await readJson(request)
    const student = data.users.find((item) => item.id === body.studentId && item.role === 'student')
    if (!student || (teacher.role === 'teacher' && student.className !== teacher.className)) {
      throw new ApiError(400, 'Choose a student from your class.')
    }
    const subject = assignedSubject(teacher, body.subject)
    const continuousAssessment = Number(body.continuousAssessment)
    const examScore = Number(body.examScore)
    if (!Number.isFinite(continuousAssessment) || continuousAssessment < 0 || continuousAssessment > 40) {
      throw new ApiError(400, 'Continuous assessment must be between 0 and 40.')
    }
    if (!Number.isFinite(examScore) || examScore < 0 || examScore > 60) {
      throw new ApiError(400, 'Exam score must be between 0 and 60.')
    }
    const totalScore = continuousAssessment + examScore
    const grade = totalScore >= 70 ? 'A' : totalScore >= 60 ? 'B' : totalScore >= 50 ? 'C' : totalScore >= 40 ? 'D' : totalScore >= 30 ? 'E' : 'F'
    const attendancePresent = Number(body.attendancePresent)
    const attendanceTotal = Number(body.attendanceTotal)
    if (!Number.isInteger(attendancePresent) || !Number.isInteger(attendanceTotal) || attendancePresent < 0 || attendanceTotal < attendancePresent) {
      throw new ApiError(400, 'Attendance days must be whole numbers and present days cannot exceed school days.')
    }
    const reportCard = {
      id: randomBytes(8).toString('hex'),
      studentId: student.id,
      studentName: student.name,
      className: student.className,
      subject,
      term: requireText(body.term, 'Term', 80),
      academicYear: requireText(body.academicYear, 'Academic year', 20),
      continuousAssessment,
      examScore,
      totalScore,
      grade,
      teacherComment: requireText(body.teacherComment, 'Teacher comment', 1000),
      attendancePresent,
      attendanceTotal,
      conduct: typeof body.conduct === 'string' ? body.conduct.trim().slice(0, 80) : '',
      headTeacherRemark: typeof body.headTeacherRemark === 'string' ? body.headTeacherRemark.trim().slice(0, 1000) : '',
      recordedBy: teacher.id,
      updatedAt: new Date().toISOString(),
    }
    data.reportCards = data.reportCards.filter((item) => !(item.studentId === student.id && item.subject?.toLowerCase() === subject.toLowerCase() && item.term === reportCard.term && item.academicYear === reportCard.academicYear))
    data.reportCards.push(reportCard)
    await saveData()
    return sendJson(response, 201, { reportCard })
  }

  if (request.method === 'POST' && url.pathname === '/api/exams') {
    const teacher = requireUser(request, ['admin', 'teacher'])
    const body = await readJson(request)
    const exam = {
      id: randomBytes(8).toString('hex'),
      title: requireText(body.title, 'Title'),
      className: assignedClass(teacher, body.className),
      subject: assignedSubject(teacher, body.subject),
      dueDate: requireText(body.dueDate, 'Deadline', 30),
      durationMinutes: Number(body.durationMinutes),
      questions: parseQuestions(body.questions),
      createdBy: teacher.id,
      createdAt: new Date().toISOString(),
    }
    const dueAt = Date.parse(exam.dueDate)
    if (!Number.isFinite(dueAt) || dueAt <= Date.now()) throw new ApiError(400, 'Enter a deadline in the future.')
    if (!Number.isInteger(exam.durationMinutes) || exam.durationMinutes < 1 || exam.durationMinutes > 240) {
      throw new ApiError(400, 'Exam time limit must be between 1 and 240 minutes.')
    }
    data.exams.unshift(exam)
    await saveData()
    return sendJson(response, 201, { exam: { ...exam, questions: exam.questions.map(({ id, text, options }) => ({ id, text, options })) } })
  }

  const startExamMatch = url.pathname.match(/^\/api\/exams\/([^/]+)\/start$/)
  if (request.method === 'POST' && startExamMatch) {
    const student = requireUser(request, ['student'])
    const exam = data.exams.find((item) => item.id === startExamMatch[1] && item.className === student.className)
    if (!exam) throw new ApiError(404, 'Exam not found for your class.')
    const deadline = Date.parse(exam.dueDate)
    if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new ApiError(410, 'This exam is past its deadline.')
    if (data.results.some((item) => item.examId === exam.id && item.studentId === student.id)) {
      throw new ApiError(409, 'You have already submitted this exam.')
    }
    if (data.examAttempts.some((item) => item.examId === exam.id && item.studentId === student.id)) {
      throw new ApiError(409, 'This exam attempt has already started and cannot be resumed.')
    }
    const attempt = { id: randomBytes(8).toString('hex'), examId: exam.id, studentId: student.id, startedAt: new Date().toISOString(), answers: {} }
    data.examAttempts.push(attempt)
    await saveData()
    return sendJson(response, 200, {
      attempt,
      exam: { ...exam, questions: exam.questions.map(({ id, text, options }) => ({ id, text, options })) },
    })
  }

  const examAnswersMatch = url.pathname.match(/^\/api\/exams\/([^/]+)\/answers$/)
  if (request.method === 'POST' && examAnswersMatch) {
    const student = requireUser(request, ['student'])
    const exam = data.exams.find((item) => item.id === examAnswersMatch[1] && item.className === student.className)
    if (!exam) throw new ApiError(404, 'Exam not found for your class.')
    const attempt = data.examAttempts.find((item) => item.examId === exam.id && item.studentId === student.id)
    if (!attempt) throw new ApiError(400, 'Start the exam before saving answers.')
    const existing = data.results.find((item) => item.examId === exam.id && item.studentId === student.id)
    if (existing) return sendJson(response, 200, { ok: true, submitted: true })
    const cutoff = Math.min(
      Date.parse(exam.dueDate),
      Date.parse(attempt.startedAt) + Number(exam.durationMinutes) * 60_000,
    )
    if (!Number.isFinite(cutoff)) throw new ApiError(400, 'The exam deadline or attempt time is invalid.')
    const requestReceivedAt = Date.now()
    const body = await readJson(request)
    if (requestReceivedAt >= cutoff) {
      const result = finishExam(exam, student, attempt, attempt.answers, cutoff)
      await saveData()
      return sendJson(response, 200, { ok: true, result })
    }
    attempt.answers = normalizeAnswers(exam.questions, body.answers)
    await saveData()
    return sendJson(response, 200, { ok: true })
  }

  const submitMatch = url.pathname.match(/^\/api\/exams\/([^/]+)\/submit$/)
  if (request.method === 'POST' && submitMatch) {
    const student = requireUser(request, ['student'])
    const exam = data.exams.find((item) => item.id === submitMatch[1] && item.className === student.className)
    if (!exam) throw new ApiError(404, 'Exam not found for your class.')
    const existing = data.results.find((item) => item.examId === exam.id && item.studentId === student.id)
    if (existing) return sendJson(response, 200, { result: existing, alreadySubmitted: true })
    const attempt = data.examAttempts.find((item) => item.examId === exam.id && item.studentId === student.id)
    if (!attempt) throw new ApiError(400, 'Start the exam before submitting it.')
    const submittedAt = Date.now()
    const body = await readJson(request)
    const cutoff = Math.min(
      Date.parse(exam.dueDate),
      Date.parse(attempt.startedAt) + Number(exam.durationMinutes) * 60_000,
    )
    if (!Number.isFinite(cutoff)) throw new ApiError(400, 'The exam deadline or attempt time is invalid.')
    const answers = submittedAt >= cutoff
      ? attempt.answers
      : normalizeAnswers(exam.questions, body.answers ?? attempt.answers)
    const result = finishExam(exam, student, attempt, answers, Math.min(submittedAt, cutoff))
    await saveData()
    return sendJson(response, 200, { result })
  }

  throw new ApiError(404, 'API endpoint not found.')
}

async function serveSite(request, response, url) {
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'
  const resolved = path.resolve(DIST_DIR, `.${pathname}`)
  if (!resolved.startsWith(`${path.resolve(DIST_DIR)}${path.sep}`)) {
    response.writeHead(400)
    return response.end('Invalid path.')
  }
  try {
    const contents = await readFile(resolved)
    response.writeHead(200, { 'content-type': MIME_TYPES[path.extname(resolved)] || 'application/octet-stream' })
    return response.end(contents)
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error
    const index = await readFile(path.join(DIST_DIR, 'index.html'))
    response.writeHead(200, { 'content-type': MIME_TYPES['.html'] })
    return response.end(index)
  }
}

export async function vercelNodeHandler(request, response) {
  const origin = request.headers.origin
  const allowedOrigins = (process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (origin && !allowedOrigins.includes(origin)) {
    return sendJson(response, 403, { error: 'This website is not allowed to use the portal API.' })
  }
  if (origin) {
    response.setHeader('access-control-allow-origin', origin)
    response.setHeader('vary', 'Origin')
  }
  response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
  response.setHeader('access-control-allow-headers', 'Authorization, Content-Type')
  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    return response.end()
  }

  const url = new URL(request.url, `https://${request.headers.host || 'localhost'}`)
  try {
    if (!url.pathname.startsWith('/api/')) throw new ApiError(404, 'API endpoint not found.')
    const isCron = url.pathname === '/api/cron/finalize'
    if (isCron) {
      const cronSecret = process.env.CRON_SECRET
      if (!cronSecret) throw new ApiError(503, 'The scheduled expiry job is not configured.')
      if (request.headers.authorization !== `Bearer ${cronSecret}`) {
        throw new ApiError(401, 'Not authorized to run the scheduled expiry job.')
      }
    }

    await connectDatabase()
    return await withPortalLock(async () => {
      await loadData()
      if (isCron) {
        await finalizeExpiredActivities()
        return sendJson(response, 200, { ok: true })
      }
      await hydrateSession(request)
      return handleApi(request, response, url)
    })
  } catch (error) {
    if (error instanceof ApiError) return sendJson(response, error.status, { error: error.message })
    console.error(error)
    return sendJson(response, 500, { error: 'The server could not complete the request.' })
  }
}

export async function startLocalServer() {
  await connectDatabase()
  await withPortalLock(async () => {
    await loadData()
    await finalizeExpiredActivities()
  })

  const activitySweep = setInterval(() => {
    withPortalLock(async () => {
      await loadData()
      await finalizeExpiredActivities()
    }).catch((error) => console.error('Unable to finalize expired school work:', error))
  }, 15_000)
  activitySweep.unref()

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
    try {
      if (url.pathname.startsWith('/api/')) {
        return await withPortalLock(async () => {
          await loadData()
          await hydrateSession(request)
          return handleApi(request, response, url)
        })
      }
      return await serveSite(request, response, url)
    } catch (error) {
      if (error instanceof ApiError) return sendJson(response, error.status, { error: error.message })
      console.error(error)
      return sendJson(response, 500, { error: 'The server could not complete the request.' })
    }
  })

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`School portal API listening on http://localhost:${PORT}`)
  })
}
