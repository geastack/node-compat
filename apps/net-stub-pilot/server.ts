import nodeConstants, { EACCES as accessDenied } from "node:constants";
import * as bareNet from "net";
import * as nodeNet from "node:net";
import {
  createServer,
  createServer as makeServer,
  Server as NetServer,
  type Socket as NetSocket,
} from "node:net";

export function compileOfficialOverloads(): void {
  makeServer({ pauseOnConnect: true }, (socket) => {
    void socket.remoteAddress;
  });
}

export function compileOfficialConstructors(): void {
  new NetServer({ pauseOnConnect: true }, (socket) => {
    void socket.remoteAddress;
  });
}

export function compileQualifiedStubs(socket: NetSocket): void {
  nodeNet.isIPv4("127.0.0.1");
  bareNet.isIPv6("::1");
  new nodeNet.Server({ pauseOnConnect: true });
  nodeNet.SocketAddress.parse("127.0.0.1:80");
  socket.address();
  void socket.bytesRead;
  void accessDenied;
  void nodeConstants.EACCES;
}

const scenario = process.argv[2] ?? "direct-call";
if (scenario === "direct-call") {
  console.log(createServer().listening);
} else if (scenario === "namespace-call") {
  console.log(nodeNet.isIPv4("127.0.0.1"));
} else if (scenario === "bare-namespace-call") {
  console.log(bareNet.isIPv6("::1"));
} else if (scenario === "constructor") {
  console.log(new nodeNet.Server().listening);
} else if (scenario === "static-method") {
  console.log(nodeNet.SocketAddress.parse("127.0.0.1:80")!.port);
} else if (scenario === "instance-method") {
  console.log(JSON.stringify(new nodeNet.Socket().address()));
} else if (scenario === "instance-property") {
  console.log(new nodeNet.Socket().bytesRead);
} else if (scenario === "named-value") {
  void accessDenied;
} else if (scenario === "default-value") {
  void nodeConstants.EACCES;
}
