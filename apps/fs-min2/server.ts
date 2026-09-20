import { Hono } from 'hono/tiny'
const app = new Hono()
console.log('min2: made Hono')
app.get('/', (c: any) => c.text('hi'))
console.log('min2: registered route')
