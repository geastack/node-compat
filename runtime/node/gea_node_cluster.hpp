// node:cluster -- the native side's declarations. Definitions live in
// gea_node.cpp (namespace gea::node::cluster and the file-scope intrinsics),
// which includes this header so every unit that includes gea_node.hpp sees
// one spelling of each symbol.
#pragma once

#include <functional>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>

namespace gea::node {

// The primary's "a worker exited" callback. The compiled program passes a
// typed closure; the same shared_ptr shape as net_set_notify keeps a move-only
// closure callable through std::function.
void cluster_set_notify_native(std::function<void()> notify);

template <typename Notify>
inline void cluster_set_notify(Notify &&notify) {
  using NotifyType = std::decay_t<Notify>;
  auto owned = std::make_shared<NotifyType>(std::forward<Notify>(notify));
  cluster_set_notify_native([owned]() mutable { (*owned)(); });
}

// A worker's "the primary is gone" callback (EOF on the inherited liveness
// pipe). A no-op when this process is not a cluster worker.
void cluster_watch_channel_native(std::function<void()> onDisconnect);

template <typename OnDisconnect>
inline void cluster_watch_channel(OnDisconnect &&onDisconnect) {
  using CallbackType = std::decay_t<OnDisconnect>;
  auto owned = std::make_shared<CallbackType>(std::forward<OnDisconnect>(onDisconnect));
  cluster_watch_channel_native([owned]() mutable { (*owned)(); });
}

// Recorded by main() so a forked worker re-executes with the same arguments.
void set_process_arguments(int argc, char **argv);

}  // namespace gea::node

double __gea_node_cluster_worker_id();
double __gea_node_cluster_fork(double id, std::string env);
std::string __gea_node_cluster_spawn_error();
double __gea_node_cluster_next_exit();
double __gea_node_cluster_exit_code();
std::string __gea_node_cluster_exit_signal();
bool __gea_node_cluster_kill(double pid, std::string signal);
double __gea_node_process_pid();
double __gea_node_process_ppid();
void __gea_node_process_exit(double code);
double __gea_node_os_available_parallelism();
