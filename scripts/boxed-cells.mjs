// `GEA_BOXED_CELLS=1` -- the boxed population of a node-compat build, in the
// goal's own units.
//
// `boxed` is a count of SELECTED representation cells
// (`result.representations.plan.selected`) whose representation TREE holds a
// `dynamic` part anywhere -- a record field, an array element, an ABI slot, an
// optional payload -- not the count of top-level `dynamic` carriers (which
// misses nested boxes) and not the count of emitted `Value::box` calls (one
// boxed parameter is one cell however many call sites box into it).
//
// The plan exists before certification, so this runs on a build that stops in
// certify just as well as on one that emits. Each selected cell is keyed by a
// `SemanticResultId`, which decodes -- with no second compiler run -- to the
// operation that published it and from there to the source node.
//
// Output (stderr):
//   [BOXED-CELL] <file:line> <cell kind> <dynamic path> <reason> in <owner file:line> «source»
//   [BOXED-BY-FILE] / [BOXED-BY-SHAPE] / [BOXED-BY-SITE] histograms
//   [BOXED-TOTAL] {...}
// `GEA_BOXED_CELLS=summary` prints the histograms only.
import { walkRepresentation } from '@geastack/compiler/dist/representation/model.js'
import { nodeOfOperation, operationOfResult } from '@geastack/compiler/dist/identity/ids.js'

const containsDynamic = (value) => {
  for (const part of walkRepresentation(value)) if (part.kind === 'dynamic') return true
  return false
}

const abiKinds = new Set([
  'function',
  'function-family',
  'constructor-family',
  'constructor-value-dispatch',
  'function-value-family',
  'function-value-dispatch'
])

// The FIRST path from the cell's root to a dynamic leaf, spelled as the member
// chain a reader follows (`.field`, `[element]`, `(param0)`, `->result`), plus
// that leaf's reason. One path is enough to name the defect; a cell with
// several dynamic leaves is still one cell.
// The innermost NAMED carrier on the path -- a record by its shape, a function
// by its id, a constructor family by its first member -- is where the `any`
// was written down: the ROOT, which many cells share (every copy, every
// reference, every call ABI that embeds that record).
const anchorOf = (value) => {
  if (value.kind === 'record' || value.kind === 'record-with-index' || value.kind === 'native-record-ref') return { shape: value.shapeId }
  if (value.kind === 'function') return { fn: value.functionId }
  if (value.kind === 'constructor-family' && value.members.length > 0) return { decl: value.members[0] }
  return null
}

const dynamicPathOf = (value, depth = 0) => {
  if (value === null || typeof value !== 'object' || depth > 16) return null
  if (value.kind === 'dynamic') return { path: '', reason: value.reason, anchor: null, anchorPath: '' }
  // Children in exactly `walkRepresentation`'s order and set, each labelled.
  const children = []
  const abiChildren = (prefix, abi) => {
    abi.parameters.forEach((parameter, index) => children.push([`${prefix}(param${index})`, parameter.value]))
    children.push([`${prefix}->result`, abi.result])
    if (abi.receiver) children.push([`${prefix}(this)`, abi.receiver])
  }
  switch (value.kind) {
    case 'record':
      for (const field of value.fields) children.push([`.${field.key}`, field.value])
      break
    case 'record-with-index':
      for (const field of value.fields) children.push([`.${field.key}`, field.value])
      for (const index of value.indexes) children.push(['[index]', index.value])
      break
    case 'proxy-object':
      children.push(['<target>', value.target], ['<handler>', value.handler])
      break
    case 'borrowed-ref':
      children.push(['&', value.referent])
      break
    case 'array-object':
      children.push(['[]', value.element])
      for (const field of value.extension ?? []) children.push([`.${field.key}`, field.value])
      break
    case 'dense-buffer':
    case 'native-sequence':
      children.push(['[]', value.element])
      break
    case 'iterator':
      children.push(['<next>', value.element], ['<resume>', value.resume], ['<done>', value.completion])
      break
    case 'promise':
      children.push(['<await>', value.value])
      break
    case 'keyed-collection':
      children.push(['<key>', value.key])
      if (value.value) children.push(['<value>', value.value])
      break
    case 'dictionary':
      children.push(['[string]', value.value])
      break
    case 'optional':
      children.push(['?', value.payload])
      break
    case 'tagged-union':
      value.arms.forEach((arm, index) => children.push([`|${arm.value.kind}#${index}`, arm.value]))
      break
    case 'function-and-constructor':
      abiChildren('call', value.call)
      abiChildren('new', value.construct)
      break
    default:
      if (abiKinds.has(value.kind)) abiChildren('', value.abi)
  }
  for (const [label, child] of children) {
    if (!containsDynamic(child)) continue
    const inner = dynamicPathOf(child, depth + 1)
    if (!inner) continue
    const path = `${label}${inner.path}`
    if (inner.anchor) return { ...inner, path }
    const anchor = anchorOf(value)
    return { path, reason: inner.reason, anchor, anchorPath: anchor ? path : '' }
  }
  return null
}

const cellKindOf = (operation) => {
  switch (operation.family) {
    case 'binding':
      return operation.parameterInitialization ? 'parameter' : operation.action === 'declare' ? 'declared-binding' : 'local'
    case 'reference':
      return operation.form === 'parameter-value'
        ? 'parameter'
        : operation.form === 'this'
          ? 'receiver'
          : operation.form === 'property' || operation.form === 'super-property' || operation.form === 'private-name'
            ? 'field-read'
            : `reference:${operation.form}`
    case 'property':
      return 'field'
    case 'invocation':
      return operation.internalMethod === 'construct' ? 'construct-result' : 'call-result'
    case 'allocation':
      return `allocation:${operation.allocated}`
    default:
      return operation.form ? `${operation.family}:${operation.form}` : operation.family
  }
}

export const reportBoxedCells = ({ result, displayPath, ownerLocation, mode }) => {
  const shapeNames = new Map()
  const nameOfShape = (id) => {
    if (shapeNames.has(id)) return shapeNames.get(id)
    let name = id
    try {
      const shape = result.graph.structuralTypes.get(id)?.shape
      const declaration = shape?.declaration ?? shape?.alias ?? null
      const location = typeof declaration === 'string' ? result.locationOfDeclaration(declaration) : null
      if (location) name = `${displayPath(location.file)}:${location.line}`
      else if (shape?.kind === 'object')
        name = `{${shape.members
          .slice(0, 4)
          .map((member) => member.key.name ?? member.key.value ?? member.key.kind)
          .join(',')}${shape.members.length > 4 ? ',...' : ''}}`
      else if (shape) name = `${shape.kind}#${id}`
    } catch {
      // An id the table does not know stays spelled as the id.
    }
    shapeNames.set(id, name)
    return name
  }
  const rootOf = (anchor) => {
    if (anchor.shape) return `type@${nameOfShape(anchor.shape)}`
    if (anchor.fn) return `fn@${ownerLocation(anchor.fn)}`
    if (anchor.decl) {
      const location = result.locationOfDeclaration(anchor.decl)
      return `class@${location ? `${displayPath(location.file)}:${location.line}` : anchor.decl}`
    }
    return '?'
  }
  // A binding's reads, writes and its declaration all name one variable, and so
  // does the bare identifier reference the same node publishes: one root.
  const declarationOfNode = new Map()
  for (const [operationId, operation] of result.graph.operations) {
    if (operation.family !== 'binding') continue
    try {
      declarationOfNode.set(nodeOfOperation(operationId), operation.declaration)
    } catch {
      // An operation with no source node names no variable.
    }
  }
  const declarationRoots = new Map()
  const variableRootOf = (declaration) => {
    if (declarationRoots.has(declaration)) return declarationRoots.get(declaration)
    const location = result.locationOfDeclaration(declaration)
    const root = location ? `var@${displayPath(location.file)}:${location.line}` : `var@${declaration}`
    declarationRoots.set(declaration, root)
    return root
  }
  const byRoot = new Map()
  const byFile = new Map()
  const byShape = new Map()
  const bySite = new Map()
  const byReason = new Map()
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)
  let cells = 0
  let unlocated = 0
  const rows = []
  for (const [resultId, representation] of result.representations.plan.selected) {
    if (!containsDynamic(representation)) continue
    cells++
    const found = dynamicPathOf(representation) ?? { path: '{?}', reason: '<unwalked>' }
    const shape = `${representation.kind}${found.path}`
    bump(byShape, shape)
    bump(byReason, found.reason)
    let site = '<unlocated>'
    let kind = '?'
    let owner = '?'
    let text = ''
    let variable = null
    try {
      const operationId = operationOfResult(resultId)
      const operation = result.graph.operations.get(operationId)
      if (operation) {
        kind = cellKindOf(operation)
        owner =
          operation.caller?.kind === 'function' ? `${ownerLocation(operation.caller.functionId)}[${operation.caller.functionId}]` : 'top-level'
        const node = nodeOfOperation(operationId)
        const declaration = operation.family === 'binding' ? operation.declaration : declarationOfNode.get(node)
        if (declaration) variable = variableRootOf(declaration)
        const location = node ? result.locationOfNode(node) : null
        if (location) site = `${displayPath(location.file)}:${location.line}`
        text = ((node ? result.textOfNode(node) : null) ?? '').replace(/\s+/g, ' ').slice(0, 90)
      }
    } catch {
      // A result id that does not decode to an operation (a synthesized cell)
      // stays unlocated rather than failing the build's report.
    }
    if (site === '<unlocated>') unlocated++
    // A cell whose dynamic leaf is its own top level, or sits inside no named
    // carrier, roots at its own site; otherwise at the named carrier's
    // declaration plus the path from it to the leaf.
    const root = found.anchor
      ? `${rootOf(found.anchor)} ${found.anchorPath}`
      : variable
        ? `${variable} ${found.path}`
        : `site@${site} «${text.slice(0, 50)}»`
    bump(byRoot, root)
    bump(byFile, site.replace(/:\d+$/, ''))
    bump(bySite, site)
    if (mode !== 'summary') rows.push(`[BOXED-CELL] ${site} ${kind} ${shape} ${found.reason} in ${owner} «${text}» root=${root}`)
  }
  for (const row of rows.sort()) console.error(row)
  const top = (map, limit) => [...map].sort((left, right) => right[1] - left[1]).slice(0, limit)
  for (const [root, count] of top(byRoot, 150)) console.error(`[BOXED-BY-ROOT] ${String(count).padStart(5)} ${root}`)
  for (const [file, count] of top(byFile, 80)) console.error(`[BOXED-BY-FILE] ${String(count).padStart(5)} ${file}`)
  for (const [shape, count] of top(byShape, 80)) console.error(`[BOXED-BY-SHAPE] ${String(count).padStart(5)} ${shape}`)
  for (const [site, count] of top(bySite, 80)) console.error(`[BOXED-BY-SITE] ${String(count).padStart(5)} ${site}`)
  for (const [reason, count] of top(byReason, 20)) console.error(`[BOXED-BY-REASON] ${String(count).padStart(5)} ${reason}`)
  // Every census refusal is an `any`/`unknown` position the call-graph proof
  // tried and failed to close -- the candidate roots, each with the reason the
  // proof stayed open. Printed in full; the build's own refusal list truncates.
  if (mode !== 'summary')
    for (const refusal of result.refusals.filter((row) => row.stage === 'census'))
      console.error(`[CENSUS-OPEN] ${refusal.key.replace(/^census:/, '')} ${refusal.reason} ${refusal.owner}`)
  const selected = result.representations.plan.selected.size
  console.error(`[BOXED-TOTAL] ${JSON.stringify({ selected, boxed: cells, unlocated, roots: byRoot.size, files: byFile.size, shapes: byShape.size })}`)
}
