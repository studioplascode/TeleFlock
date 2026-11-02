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
        /// The app just installed this build: stop a running daemon that runs another binary
        /// first, unless it is newer, or the same version with clients attached.
        #[arg(long)]
        replace: bool,
    },
    /// Gracefully stop the running daemon.
    Stop {
        /// Stop it even if it refuses (it keeps serving connected clients against older builds).
        #[arg(long)]
        force: bool,
    },
    /// Start the daemon detached unless it is running, then exit (the boot service runs this:
    /// a systemd timer, a launchd agent or a Task Scheduler task).
    Ensure,
    /// Run a command, a login shell or a tool on another host through a TeleFlock app
    /// (`tf-forward <name> [-t|-T] [--cwd DIR] [--] [command…]`, `tf-forward --list`).
    #[command(disable_help_flag = true)]
    Forward {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
}

fn main() {
    // `forward` takes its arguments as they are (ssh-like: options of the remote command pass
    // through), so it is dispatched before clap sees them.
    let mut argv = std::env::args_os();
    if argv.nth(1).is_some_and(|a| a == "forward") {
        let args: Vec<String> = argv
            .enumerate()
            .map(|(i, a)| a.into_string().map_err(|_| i + 1))
            .collect::<Result<_, _>>()
            .unwrap_or_else(|n| {
                eprintln!("tf-forward: argument {n} is not UTF-8");
                std::process::exit(255)
            });
        tf_hostd::forward::cli::main(args);
    }
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
        Some(Cmd::Stop { force }) => tf_hostd::attach::stop(paths, force),
        Some(Cmd::Ensure) => tf_hostd::attach::ensure(paths, cli.relay_port),
        Some(Cmd::Forward { args }) => tf_hostd::forward::cli::main(args),
        None => {
            eprintln!("tf-hostd: missing command (daemon | attach | ensure | stop | --version)");
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
