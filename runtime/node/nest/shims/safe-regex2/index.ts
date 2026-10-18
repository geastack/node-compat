import { tokenizer, types, type Root, type Token } from '../ret/index'

export interface SafeRegexOptions {
  limit?: number
}

interface WalkState {
  reps: number
  limit: number
}

const walkStack = (stack: Token[], state: WalkState, starHeight: number): boolean => {
  for (const token of stack) if (!walk(token, state, starHeight)) return false
  return true
}

const walkOptions = (options: Token[][] | undefined, state: WalkState, starHeight: number): boolean => {
  if (!options) return true
  for (const option of options) if (!walkStack(option, state, starHeight)) return false
  return true
}

function walk(node: Root | Token, state: WalkState, starHeight: number): boolean {
  if (node.type === types.REPETITION) {
    starHeight++
    state.reps++
    if (starHeight > 1) return false
    if (state.reps > state.limit) return false
  }

  const clause = node.type === types.ROOT || node.type === types.GROUP ? node : node.type === types.REPETITION && node.value.type === types.GROUP ? node.value : null
  if (clause === null) return true
  if (!walkOptions(clause.options, state, starHeight)) return false
  if (!clause.stack) return true
  return walkStack(clause.stack, state, starHeight)
}

export function safeRegex(re: RegExp | string, options?: SafeRegexOptions): boolean {
  const state: WalkState = { reps: 0, limit: options?.limit ?? 25 }
  const source = typeof re === 'string' ? re : re.source
  try {
    return walk(tokenizer(source), state, 0)
  } catch {
    return false
  }
}

export default safeRegex
