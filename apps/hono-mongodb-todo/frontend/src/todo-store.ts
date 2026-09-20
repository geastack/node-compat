import { Store } from '@geajs/core'
import type { CreateTodoInput, Todo, UpdateTodoInput } from '../../shared/todo-contract'

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null
}

function isTodo(value: unknown): value is Todo {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.completed === 'boolean' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function decodeTodo(value: unknown): Todo {
  if (!isTodo(value)) throw new Error('The server returned an invalid todo')
  return value
}

function decodeTodoList(value: unknown): Todo[] {
  if (!Array.isArray(value) || !value.every(isTodo)) {
    throw new Error('The server returned an invalid todo list')
  }
  return value
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init)
  if (!response.ok) {
    const message = await response.text()
    throw new Error(message.length > 0 ? message : `Request failed with status ${response.status}`)
  }
  if (response.status === 204) return null
  const value: unknown = await response.json()
  return value
}

class TodoStore extends Store {
  todos: Todo[] = []
  draft = ''
  loading = false
  saving = false
  error = ''

  get remainingCount(): number {
    return this.todos.filter((todo) => !todo.completed).length
  }

  setDraft(value: string): void {
    this.draft = value
  }

  async load(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      this.todos = decodeTodoList(await request('/api/todos'))
    } catch (error: unknown) {
      this.error = error instanceof Error ? error.message : 'Could not load todos'
    } finally {
      this.loading = false
    }
  }

  async create(): Promise<void> {
    const title = this.draft.trim()
    if (title.length === 0 || this.saving) return

    this.saving = true
    this.error = ''
    const input: CreateTodoInput = { title }
    try {
      const todo = decodeTodo(
        await request('/api/todos', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input)
        })
      )
      this.todos.push(todo)
      this.draft = ''
    } catch (error: unknown) {
      this.error = error instanceof Error ? error.message : 'Could not create the todo'
    } finally {
      this.saving = false
    }
  }

  async update(id: string, input: UpdateTodoInput): Promise<void> {
    this.error = ''
    try {
      const updated = decodeTodo(
        await request(`/api/todos/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input)
        })
      )
      const index = this.todos.findIndex((todo) => todo.id === id)
      if (index >= 0) this.todos[index] = updated
    } catch (error: unknown) {
      this.error = error instanceof Error ? error.message : 'Could not update the todo'
    }
  }

  async remove(id: string): Promise<void> {
    this.error = ''
    try {
      await request(`/api/todos/${id}`, { method: 'DELETE' })
      this.todos = this.todos.filter((todo) => todo.id !== id)
    } catch (error: unknown) {
      this.error = error instanceof Error ? error.message : 'Could not delete the todo'
    }
  }
}

export default new TodoStore()
