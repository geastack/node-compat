type Completion = (error?: Error | null, value?: string) => void

class BaseTransform {
  transform(_input: string, callback: Completion): void {
    callback(null, 'base')
  }

  write(input: string, callback: Completion): void {
    this.transform(input, callback)
  }
}

class DerivedTransform extends BaseTransform {
  override transform(_input: string, callback: Completion): void {
    callback(null, 'derived')
  }
}

const transform: BaseTransform = new DerivedTransform()
transform.write('input', (_error, value) => {
  if (value !== 'derived') {
    throw new Error(`virtual callback dispatch failed: expected derived, received ${value}`)
  }
  console.log('virtual-callback-dispatch-ok')
})
