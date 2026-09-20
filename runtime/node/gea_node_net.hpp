#pragma once

// Typed bridge for node:net. Socket notifications carry no payload across the
// host boundary; TypeScript drains a native event queue and fetches byte chunks
// as gea_node_buffer, so MongoDB wire bytes never pass through gea_cpp_value.

#include "gea_node_buffer.hpp"

#include <functional>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>

namespace gea::node {

double net_create_native(std::string host, double port, double family, double hints, std::string local_address,
                         double local_port, bool bind_local, std::function<void()> notify);

template <typename Notify>
inline double net_create(std::string host, double port, double family, double hints, std::string local_address,
                         double local_port, bool bind_local, Notify &&notify) {
  using NotifyType = std::decay_t<Notify>;
  auto owned = std::make_shared<NotifyType>(std::forward<Notify>(notify));
  return net_create_native(std::move(host), port, family, hints, std::move(local_address), local_port, bind_local,
                           [owned]() mutable { (*owned)(); });
}

std::string net_create_error();
double net_next_event(double id);
std::vector<std::uint8_t> net_read(double id);
std::string net_error(double id);
bool net_write(double id, const gea::TypedArray<std::uint8_t> &buffer);
double mongodb_pool_open(std::string host, double port, double max_size);
std::vector<std::uint8_t> mongodb_pool_exchange(double pool_id, const gea::TypedArray<std::uint8_t> &request);
void mongodb_pool_close(double pool_id);
double net_buffer_size(double id);
void net_end(double id);
void net_destroy(double id);
void net_reset_and_destroy(double id);
void net_set_paused(double id, bool paused);
void net_set_referenced(double id, bool referenced);
void net_set_notify_native(double id, std::function<void()> notify);

template <typename Notify>
inline void net_set_notify(double id, Notify &&notify) {
  using NotifyType = std::decay_t<Notify>;
  auto owned = std::make_shared<NotifyType>(std::forward<Notify>(notify));
  net_set_notify_native(id, [owned]() mutable { (*owned)(); });
}
void net_set_keep_alive(double id, bool enabled, double initial_delay_ms);
void net_set_no_delay(double id, bool enabled);
std::string net_remote_address(double id);
double net_remote_port(double id);
std::string net_remote_family(double id);
std::string net_local_address(double id);
double net_local_port(double id);
std::string net_local_family(double id);
double net_is_ip(const std::string &input);
std::string net_normalize_ip(const std::string &input, double family);
double net_ip_compare(const std::string &left, double left_family, const std::string &right, double right_family);
bool net_ip_in_subnet(const std::string &address, double address_family, const std::string &network,
                      double network_family, double prefix);

double net_server_listen_native(std::string host, double port, double family, double backlog, bool reuse_port,
                                bool ipv6_only, double max_connections, std::function<void()> notify);

template <typename Notify>
inline double net_server_listen(std::string host, double port, double family, double backlog, bool reuse_port,
                                bool ipv6_only, double max_connections, Notify &&notify) {
  using NotifyType = std::decay_t<Notify>;
  auto owned = std::make_shared<NotifyType>(std::forward<Notify>(notify));
  return net_server_listen_native(std::move(host), port, family, backlog, reuse_port, ipv6_only, max_connections,
                                  [owned]() mutable { (*owned)(); });
}

std::string net_server_create_error();
std::string net_server_error(double id);
double net_server_next_event(double id);
double net_server_take_connection(double id);
void net_server_close(double id);
void net_server_set_referenced(double id, bool referenced);
void net_server_set_max_connections(double id, double max_connections);
double net_server_connections(double id);
std::string net_server_address(double id);
double net_server_port(double id);
std::string net_server_family(double id);

}  // namespace gea::node

// Timer symbols are also emitted directly by imported builtin aliases. Keep
// the declarations in the generated support header so every module sees them,
// not only the timers.ts translation unit.
double __gea_node_set_timeout(std::function<void()> callback, double delay_ms);
double __gea_node_set_interval(std::function<void()> callback, double delay_ms);
void __gea_node_clear_timer(double id);
void __gea_node_timer_unref(double id);
