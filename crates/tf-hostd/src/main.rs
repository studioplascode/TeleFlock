//! `tf-hostd`: TeleFlock host daemon CLI (architecture §3.2).

use clap::{Parser, Subcommand};

use tf_hostd::paths::Paths;

#[derive(Parser)]
#[command(name = "tf-hostd", about = "TeleFlock host daemon", disable_version_flag = true)]
struct Cli {
    /// Print `tf-hostd <version> proto <n>` and exit.
    #[arg(long, short = 'V')]
    version: bool,
    /// Loopback port of the embedded omp collab relay.
    #[arg(long, global = true, default_value_t = tf_proto::DEFAULT_RELAY_PORT)]
    relay_port: u16,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the long-lived daemon (normally started by `attach`).
    Daemon,
    /// Bridge stdio to the daemon's client socket, starting the daemon if needed.
    Attach {
        /// herdr session the client will attach to (the client's hello decides).
        #[arg(long, default_value = "default")]
        session: String,
        /// Stop a running daemon that runs a different binary first.
        #[arg(long)]
        replace: bool,
    },
    /// Gracefully stop the running daemon.
    Stop,
}

fn main() {
    let cli = Cli::parse();
    if cli.version {
        println!("{}", tf_hostd::version_line());
        return;
    }
    let paths = Paths::from_env();
    let result = match cli.cmd {
        Some(Cmd::Daemon) => tf_hostd::daemon::run(paths, cli.relay_port),
        Some(Cmd::Attach { session, replace }) => {
            tf_hostd::logging::init_stderr();
            tf_hostd::attach::run(paths, &session, replace, cli.relay_port)
        }
        Some(Cmd::Stop) => tf_hostd::attach::stop(paths),
        None => {
            eprintln!("tf-hostd: missing command (daemon | attach | stop | --version)");
            Ok(2)
        }
    };
    match result {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("tf-hostd: {e:#}");
            std::process::exit(1);
        }
    }
}
