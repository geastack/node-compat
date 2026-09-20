import { Component } from '@geajs/core'
import TodoRow from './todo-row'
import todoStore from './todo-store'

export default class App extends Component {
  created(): void {
    void todoStore.load()
  }

  updateDraft(event: Event): void {
    const target = event.currentTarget
    if (target instanceof HTMLInputElement) todoStore.setDraft(target.value)
  }

  submit(event: Event): void {
    event.preventDefault()
    void todoStore.create()
  }

  template() {
    const { todos, draft, loading, saving, error } = todoStore
    return (
      <div class="page-shell">
        <section class="todo-card">
          <header class="masthead">
            <p class="eyebrow">Compiled full stack</p>
            <h1>Things worth doing.</h1>
            <p class="lede">Gea in the browser. Hono at the edge. MongoDB underneath.</p>
          </header>

          <form class="todo-form" submit={this.submit}>
            <label for="new-todo">Add a task</label>
            <div class="input-row">
              <input
                id="new-todo"
                type="text"
                value={draft}
                placeholder="Ship the native build"
                autoComplete="off"
                input={this.updateDraft}
              />
              <button type="submit" disabled={saving || draft.trim().length === 0}>
                {saving ? 'Adding…' : 'Add'}
              </button>
            </div>
          </form>

          {error.length > 0 && <p class="error" role="alert">{error}</p>}

          <div class="list-heading">
            <h2>Today</h2>
            <span>{todoStore.remainingCount} remaining</span>
          </div>

          {loading ? (
            <p class="empty-state">Loading tasks…</p>
          ) : todos.length === 0 ? (
            <p class="empty-state">The list is clear. Add the first task above.</p>
          ) : (
            <ul class="todo-list">
              {todos.map((todo) => (
                <TodoRow key={todo.id} todo={todo} />
              ))}
            </ul>
          )}

          <footer>
            <span>@geajs/core</span>
            <span aria-hidden="true">×</span>
            <span>Hono</span>
            <span aria-hidden="true">×</span>
            <span>MongoDB</span>
          </footer>
        </section>
      </div>
    )
  }
}
