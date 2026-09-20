import { Component } from '@geajs/core'
import type { Todo, UpdateTodoInput } from '../../shared/todo-contract'
import todoStore from './todo-store'

export default class TodoRow extends Component {
  declare props: { todo: Todo }

  toggle(): void {
    const todo = this.props.todo
    const input: UpdateTodoInput = { completed: !todo.completed }
    void todoStore.update(todo.id, input)
  }

  remove(): void {
    void todoStore.remove(this.props.todo.id)
  }

  template({ todo }: this['props']) {
    return (
      <li class={`todo-row ${todo.completed ? 'is-complete' : ''}`}>
        <button
          class="todo-check"
          type="button"
          aria-label={todo.completed ? `Mark ${todo.title} incomplete` : `Mark ${todo.title} complete`}
          click={this.toggle}
        >
          <span>{todo.completed ? '✓' : ''}</span>
        </button>
        <span class="todo-title">{todo.title}</span>
        <button class="todo-delete" type="button" aria-label={`Delete ${todo.title}`} click={this.remove}>
          Remove
        </button>
      </li>
    )
  }
}
