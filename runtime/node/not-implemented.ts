export const NODE_COMPAT_TARGET = 'node@24'

export interface NodeNotImplementedError extends Error {
  code: 'ERR_GEA_NODE_NOT_IMPLEMENTED'
  moduleName: string
  memberName: string
  target: string
}

export function nodeNotImplemented(moduleName: string, memberName: string): never {
  const target = NODE_COMPAT_TARGET
  const error = new Error(
    `ERR_GEA_NODE_NOT_IMPLEMENTED: ${moduleName}.${memberName} is not implemented for geastack target ${target}`
  ) as NodeNotImplementedError
  error.name = 'NodeNotImplementedError'
  error.code = 'ERR_GEA_NODE_NOT_IMPLEMENTED'
  error.moduleName = moduleName
  error.memberName = memberName
  error.target = target
  throw error
}
