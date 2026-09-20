import { createServer, type IncomingMessage } from 'node:http'
import { env } from 'node:process'
import { Hono } from 'hono'
import { MongoClient, ObjectId } from 'mongodb'
import type { Collection, Document } from 'mongodb'
import type { CreateTodoInput, Todo, UpdateTodoInput } from './shared/todo-contract.js'
import {
  FRONTEND_HTML,
  FRONTEND_SCRIPT,
  FRONTEND_SCRIPT_PATH,
  FRONTEND_STYLE,
  FRONTEND_STYLE_PATH
} from './generated/frontend-assets.js'

interface TodoDocument {
  _id: ObjectId
  title: string
  completed: boolean
  createdAt: Date
  updatedAt: Date
}

const MONGODB_URL = env.MONGODB_URL ?? 'mongodb://127.0.0.1:27017'
const DATABASE_NAME = 'gea_hono_todo'
const PORT = Number(env.PORT ?? '3000')

const mongoClient = new MongoClient(MONGODB_URL)
const todos: Collection<TodoDocument> = mongoClient.db(DATABASE_NAME).collection<TodoDocument>('todos')
const app = new Hono()

function toTodo(document: TodoDocument): Todo {
  return {
    id: document._id.toHexString(),
    title: document.title,
    completed: document.completed,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString()
  }
}

function todoDocumentFrom(document: Document): TodoDocument {
  return {
    _id: document._id as ObjectId,
    title: document.title as string,
    completed: document.completed as boolean,
    createdAt: document.createdAt as Date,
    updatedAt: document.updatedAt as Date
  }
}

function textResponse(body: string, contentType: string, status: number): Response {
  const response = new Response(body, { status })
  response.headers.set('content-type', contentType)
  return response
}

function todoResponse(todo: Todo, status: number): Response {
  return textResponse(JSON.stringify(todo), 'application/json; charset=utf-8', status)
}

function todosResponse(todoList: Todo[]): Response {
  return textResponse(JSON.stringify(todoList), 'application/json; charset=utf-8', 200)
}

function errorResponse(message: string, status: number): Response {
  return textResponse(JSON.stringify({ error: message }), 'application/json; charset=utf-8', status)
}

function incomingBody(request: IncomingMessage): Promise<string> {
  try {
    const geaRequest = request as IncomingMessage & { readBody(): string }
    return Promise.resolve(geaRequest.readBody())
  } catch {}
  return new Promise<string>((resolve, reject): void => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string): void => {
      body += chunk
    })
    request.on('end', (): void => resolve(body))
    request.on('error', (error: Error): void => reject(error))
  })
}

function routeTodoId(path: string): string | undefined {
  const prefix = '/api/todos/'
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null
}

function parseCreateInput(value: unknown): CreateTodoInput | null {
  if (!isObject(value) || typeof value.title !== 'string') return null
  const title = value.title.trim()
  if (title.length === 0 || title.length > 240) return null
  return { title }
}

function parseUpdateInput(value: unknown): UpdateTodoInput | null {
  if (!isObject(value)) return null
  const input: UpdateTodoInput = {}
  if (value.title !== undefined) {
    if (typeof value.title !== 'string') return null
    const title = value.title.trim()
    if (title.length === 0 || title.length > 240) return null
    input.title = title
  }
  if (value.completed !== undefined) {
    if (typeof value.completed !== 'boolean') return null
    input.completed = value.completed
  }
  if (input.title === undefined && input.completed === undefined) return null
  return input
}

function objectIdFrom(value: string | undefined): ObjectId | null {
  return value !== undefined && ObjectId.isValid(value) ? new ObjectId(value) : null
}

app.get('/', () => textResponse(FRONTEND_HTML, 'text/html; charset=utf-8', 200))
app.get(FRONTEND_SCRIPT_PATH, () =>
  textResponse(FRONTEND_SCRIPT, 'text/javascript; charset=utf-8', 200)
)
app.get(FRONTEND_STYLE_PATH, () => textResponse(FRONTEND_STYLE, 'text/css; charset=utf-8', 200))

app.get('/api/todos', async () => {
  const documents = await todos.find({}).sort({ createdAt: 1 }).toArray()
  return todosResponse(documents.map((document: Document) => toTodo(todoDocumentFrom(document))))
})

app.post('/api/todos', async (c) => {
  const input = parseCreateInput(await c.req.json())
  if (input === null) return errorResponse('title must contain 1 to 240 characters', 400)

  const now = new Date()
  const id = new ObjectId()
  const todo: Todo = {
    id: id.toHexString(),
    title: input.title,
    completed: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  }
  const document: Document = {
    _id: id,
    title: todo.title,
    completed: todo.completed,
    createdAt: now,
    updatedAt: now
  }
  await todos.insertOne(document as TodoDocument)
  return todoResponse(todo, 201)
})

app.patch('/api/todos/:id', async (c) => {
  const id = objectIdFrom(routeTodoId(c.req.path))
  if (id === null) return errorResponse('invalid todo id', 400)

  const input = parseUpdateInput(await c.req.json())
  if (input === null) return errorResponse('provide a valid title or completed value', 400)

  const updatedAt = new Date()
  if (input.title !== undefined && input.completed !== undefined) {
    await todos.updateOne(
      { _id: id },
      { $set: { title: input.title, completed: input.completed, updatedAt } }
    )
  } else if (input.title !== undefined) {
    await todos.updateOne({ _id: id }, { $set: { title: input.title, updatedAt } })
  } else if (input.completed !== undefined) {
    await todos.updateOne({ _id: id }, { $set: { completed: input.completed, updatedAt } })
  }

  const result = await todos.findOne({ _id: id })
  if (result === null) return errorResponse('todo not found', 404)
  return todoResponse(toTodo(todoDocumentFrom(result)), 200)
})

app.delete('/api/todos/:id', async (c) => {
  const id = objectIdFrom(routeTodoId(c.req.path))
  if (id === null) return errorResponse('invalid todo id', 400)
  const result = await todos.deleteOne({ _id: id })
  if (result.deletedCount === 0) return errorResponse('todo not found', 404)
  return new Response(null, { status: 204 })
})

const server = createServer(async (req, res) => {
  const method = req.method ?? 'GET'
  const body = method === 'GET' || method === 'HEAD' ? '' : await incomingBody(req)
  const requestHeaders: Record<string, string> = {}
  const contentType = req.headers['content-type']
  if (typeof contentType === 'string') requestHeaders['content-type'] = contentType

  const init: RequestInit = { method, headers: requestHeaders }
  if (method !== 'GET' && method !== 'HEAD') init.body = Buffer.from(body, 'latin1')

  const request = new Request(`http://localhost${req.url ?? '/'}`, init)
  const response = await app.fetch(request)
  const responseBody = await response.text()
  const responseContentType = response.headers.get('content-type') ?? 'text/plain; charset=utf-8'
  res.writeHead(response.status, { 'content-type': responseContentType })
  res.end(responseBody)
})

async function start(): Promise<void> {
  await mongoClient.connect()
  const ping = await mongoClient.db('admin').command({ ping: 1 })
  if (ping.ok !== 1) throw new Error(`MongoDB ping returned ${String(ping.ok)}`)

  server.listen(PORT, () => {
    console.log(`gea-hono-mongodb-todo listening on http://127.0.0.1:${PORT}`)
  })
}

await start()
