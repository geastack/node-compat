import cluster from "node:cluster";
import Fastify from "fastify";

const workers = Number(process.env.NODE_WORKERS ?? 1);
if (cluster.isPrimary && workers > 1) {
  let ready = 0;
  const pids = [process.pid];
  for (let index = 0; index < workers; index++) {
    const worker = cluster.fork();
    pids.push(worker.process.pid);
    worker.on("message", (message) => {
      if (message.ready && ++ready === workers)
        console.log(JSON.stringify({ ready: true, port: message.port, pids }));
    });
  }
} else {
  const app = Fastify({ logger: false });
  app.get("/", (_req, reply) => reply.send("Hello Fastify!"));
  app.get("/json", (_req, reply) => reply.send({ hello: "world" }));
  app.get(
    "/schema",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: { hello: { type: "string" } },
            required: ["hello"],
          },
        },
      },
    },
    (_req, reply) => reply.send({ hello: "world" }),
  );
  app.get("/users/:id", (req, reply) => reply.send({ id: req.params.id }));
  await app.listen({
    port: Number(process.env.PORT ?? 3000),
    host: "127.0.0.1",
  });
  const port = app.server.address().port;
  if (process.send) process.send({ ready: true, port });
  else console.log(JSON.stringify({ ready: true, port, pids: [process.pid] }));
}
