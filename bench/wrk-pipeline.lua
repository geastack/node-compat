-- HTTP/1.1 pipelining for wrk: each write carries `depth` GET requests.
--
-- Usage: wrk -s bench/wrk-pipeline.lua <url> -- [depth]   (depth defaults to 16)
--
-- Pipelining divides the per-request kernel cost (wake-ups, read/write
-- syscalls) by the depth, so requests/sec tracks the server's own user-space
-- work instead of the host's syscall and scheduling latency. Use it to compare
-- servers on a host where unpipelined loopback is latency-bound.

local depth = 16
local batch

function init(args)
  depth = tonumber(args[1]) or depth
  local one = wrk.format(nil, wrk.path)
  batch = string.rep(one, depth)
end

function request()
  return batch
end
