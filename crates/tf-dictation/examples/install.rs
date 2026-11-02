//! Installs a speech model into an app data dir and chooses it, as Settings → Dictation does.
//! For labs and tests without the UI.
//!
//! cargo run -p tf-dictation --example install -- --data-dir <dir> [--model <id>] [--from <dir>]
//!
//! `--from`: take the files from a local directory (hard links when possible, else copies),
//! still checked against the catalog's sha256; otherwise they are downloaded. The directory is
//! the model's own, or one holding sherpa-onnx's release directories (named after their Hugging
//! Face repositories, `<dir>/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/`).

use std::{path::PathBuf, sync::atomic::AtomicBool};

use tf_dictation::{
    catalog::{self, DeviceClass},
    store::{Downloader, Store, sha256_file},
};

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut data_dir, mut model, mut from) = (None, None, None);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--data-dir" => data_dir = args.next().map(PathBuf::from),
            "--model" => model = args.next(),
            "--from" => from = args.next().map(PathBuf::from),
            _ => panic!("unknown argument {a}"),
        }
    }
    let data_dir = data_dir.expect("--data-dir <dir>");
    let model = match model {
        Some(id) => catalog::find(&id).unwrap_or_else(|| panic!("unknown model {id}; one of: {}", catalog::CATALOG.iter().map(|m| m.id).collect::<Vec<_>>().join(", "))),
        None => catalog::recommended(DeviceClass::current()),
    };
    let store = Store::new(&data_dir);
    if let Some(src) = from {
        let release = src.join(model.repo.rsplit('/').next().unwrap_or(model.repo));
        let src = if release.is_dir() { release } else { src };
        let dir = store.model_dir(model);
        std::fs::create_dir_all(&dir).unwrap();
        for f in model.files {
            let (s, d) = (src.join(f.name), dir.join(f.name));
            let _ = std::fs::remove_file(&d);
            if std::fs::hard_link(&s, &d).is_err() {
                std::fs::copy(&s, &d).unwrap_or_else(|e| panic!("copy {}: {e}", s.display()));
            }
            assert_eq!(sha256_file(&d).as_deref(), Some(f.sha256), "{} doesn't match the catalog", f.name);
        }
        std::fs::write(dir.join(".complete"), model.commit).unwrap();
    } else {
        let dl = Downloader::new("TeleFlock-lab").unwrap();
        let total = model.size();
        store
            .download(model, &dl, &AtomicBool::new(false), &|n| eprint!("\r{} {:.0} %   ", model.id, n as f64 * 100.0 / total as f64))
            .unwrap();
        eprintln!();
    }
    assert!(store.installed(model));
    store.update_prefs(|p| p.selected = Some(model.id.into())).unwrap();
    println!("{} installed and chosen in {}", model.id, store.root().display());
}
