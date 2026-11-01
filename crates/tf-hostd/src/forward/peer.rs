//! Who connected to a forwarded port (Linux). Forwarded ports listen on 127.0.0.1, which every
//! account on the host can reach; only this user's processes may use them. The connecting
//! socket's owner is in `/proc/net/tcp`: its row has the accepted connection's peer as its local
//! address and the listener as its remote one.

use std::net::{SocketAddr, SocketAddrV4};

/// The uid owning the socket that connected from `peer` to `local` (an accepted connection's
/// two ends), if the table has it.
pub(crate) fn uid_of(peer: SocketAddr, local: SocketAddr) -> Option<u32> {
    let (SocketAddr::V4(peer), SocketAddr::V4(local)) = (peer, local) else { return None };
    find(&std::fs::read_to_string("/proc/net/tcp").ok()?, peer, local)
}

/// The `uid` column of the row whose local address is `from` and remote address `to`.
fn find(table: &str, from: SocketAddrV4, to: SocketAddrV4) -> Option<u32> {
    let (from, to) = (hex(from), hex(to));
    table.lines().skip(1).find_map(|line| {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() > 7 && f[1].eq_ignore_ascii_case(&from) && f[2].eq_ignore_ascii_case(&to) { f[7].parse().ok() } else { None }
    })
}

/// An address as `/proc/net/tcp` prints it: the address's bytes read as a native u32, `%08X`,
/// then the port, `%04X`.
fn hex(a: SocketAddrV4) -> String {
    format!("{:08X}:{:04X}", u32::from_ne_bytes(a.ip().octets()), a.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_connecting_socket_is_found_with_its_owner() {
        let addr = |s: &str| s.parse::<SocketAddrV4>().unwrap();
        let (peer, listener) = (addr("127.0.0.1:51234"), addr("127.0.0.1:9222"));
        let (p, l) = (hex(peer), hex(listener));
        let row = |n: u32, local: &str, remote: &str, uid: u32| format!("  {n}: {local} {remote} 01 00000000:00000000 00:00000000 00000000 {uid:>5}        0 {n}0 1 0000000000000000 20 4 30 10 -1\n");
        let header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
        // The listener and the accepted socket belong to this daemon's user; the connecting
        // socket (peer → listener) to another one.
        let table = format!("{header}{}{}{}", row(0, &l, "00000000:0000", 1000), row(1, &l, &p, 1000), row(2, &p, &l, 1001));
        assert_eq!(find(&table, peer, listener), Some(1001));
        assert_eq!(find(&table, addr("127.0.0.1:51235"), listener), None, "no such connection");
        assert_eq!(hex(addr("127.0.0.1:8080")), format!("{:08X}:1F90", u32::from_ne_bytes([127, 0, 0, 1])));
    }

    /// The real table: a connection this process makes is found as its own.
    #[test]
    fn a_connection_of_this_process_is_its_users() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let _client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (accepted, peer) = listener.accept().unwrap();
        // SAFETY: geteuid cannot fail.
        assert_eq!(uid_of(peer, accepted.local_addr().unwrap()), Some(unsafe { libc::geteuid() }));
    }
}
