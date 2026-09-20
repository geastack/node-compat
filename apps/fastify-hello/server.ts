import Fastify from 'fastify'

const app = Fastify({ logger: false })

app.get('/', (req: any, reply: any) => {
  reply.send('Hello Fastify!')
})

app.listen({ port: 3000, host: '127.0.0.1' }, (err: any, address: any) => {
  console.log('fastify listening on ' + address)
})
