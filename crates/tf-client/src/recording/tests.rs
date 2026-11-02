use std::sync::atomic::AtomicUsize;

use serde::de::DeserializeOwned;
use serde_json::json;
use tf_proto::{HostProfile, Notification};

use super::*;

/// A fake JPEG: SOI, `n - 4` fill bytes, EOI.
fn jpeg(n: usize, fill: u8) -> Vec<u8> {
    let mut v = vec![fill; n];
    v[..2].copy_from_slice(&[0xFF, 0xD8]);
    v[n - 2..].copy_from_slice(&[0xFF, 0xD9]);
    v
}

fn frame(t: u64, j: &[u8]) -> Value {
    json!({ "t": t, "data": B64.encode(j), "width": 64, "height": 48 })
}

async fn call<T: DeserializeOwned>(rs: &Arc<Recordings>, method: &str, params: Value) -> Result<T, ApiError> {
    let v = rs.call(AppMethod::parse(method, params)?).await?;
    Ok(serde_json::from_value(v).unwrap())
}

/// Recordings with `limits` whose events are counted.
async fn recordings(dir: &Path, limits: Limits) -> (Arc<Recordings>, Arc<AtomicUsize>) {
    let rs = Recordings::load_with(dir, limits).await;
    let events = Arc::new(AtomicUsize::new(0));
    let n = events.clone();
    let _ = rs.emit.set(Box::new(move || {
        n.fetch_add(1, Ordering::SeqCst);
    }));
    (rs, events)
}

/// Waits until the background work is done with the recording.
async fn settled_rs(rs: &Arc<Recordings>, id: &str) -> RecordingInfo {
    for _ in 0..1000 {
        let info = rs.list().recordings.into_iter().find(|r| r.id == id).expect("listed");
        if matches!(info.state, RecordingState::Ready | RecordingState::Failed) {
            return info;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{id} did not finish processing");
}

/// Recording → stop → video: every frame stays readable by index (from `frames.bin`, then
/// from `recording.mov`), the index points into the video, `frames.bin` is gone, events go out
/// on state changes but not per append, and nothing of a refused append is written.
#[tokio::test(flavor = "multi_thread")]
async fn record_stop_and_read_back() {
    let dir = tempfile::tempdir().unwrap();
    let (rs, events) = recordings(dir.path(), Limits::default()).await;
    let info: RecordingInfo = call(&rs, "recording.start", json!({ "title": "  Login bug ", "voice": false })).await.unwrap();
    assert!(store::valid_id(&info.id), "{}", info.id);
    assert_eq!((info.title.as_str(), info.state, info.voice.state, info.transcript.state), ("Login bug", RecordingState::Recording, VoiceState::Off, TranscriptState::None));
    assert_eq!(events.load(Ordering::SeqCst), 1);
    let id = info.id.clone();
    let rdir = dir.path().join("recordings").join(&id);
    assert!(rdir.join(store::META).exists());

    let e = call::<RecordingInfo>(&rs, "recording.start", json!({})).await.unwrap_err();
    assert_eq!(e.code, "busy");

    let jpegs = [jpeg(300, 1), jpeg(200, 2), jpeg(250, 3)];
    let out: RecordingAppended = call(
        &rs,
        "recording.append",
        json!({ "id": id, "frames": [frame(0, &jpegs[0]), frame(1200, &jpegs[1])], "events": [{ "t": 5, "kind": "click" }],
                "shots": [{ "name": "start.png", "data": B64.encode(b"\x89PNG\r\n\x1a\nxyz") }] }),
    )
    .await
    .unwrap();
    assert_eq!(out.stop, None);
    assert_eq!(out.bytes, store::folder_size(&rdir));
    // An older time counts as the last frame's; a frame of another size is refused whole.
    let _: RecordingAppended = call(&rs, "recording.append", json!({ "id": id, "frames": [frame(900, &jpegs[2])], "events": [{ "t": 6, "kind": "key" }] })).await.unwrap();
    let bad = json!({ "id": id, "frames": [{ "t": 2000, "data": B64.encode(&jpegs[0]), "width": 32, "height": 48 }], "events": [{ "t": 7 }] });
    assert_eq!(call::<RecordingAppended>(&rs, "recording.append", bad).await.unwrap_err().code, "invalid_params");
    let bad = json!({ "id": id, "shots": [{ "name": "../meta.json", "data": "" }] });
    assert_eq!(call::<RecordingAppended>(&rs, "recording.append", bad).await.unwrap_err().code, "invalid_params");
    assert_eq!(events.load(Ordering::SeqCst), 1, "appends send no event");

    let paused: RecordingInfo = call(&rs, "recording.pause", json!({ "id": id })).await.unwrap();
    assert_eq!(paused.state, RecordingState::Paused);
    let d = paused.duration_ms;
    tokio::time::sleep(Duration::from_millis(30)).await;
    let still: RecordingList = call(&rs, "recording.list", json!({})).await.unwrap();
    assert_eq!(still.recordings[0].duration_ms, d, "paused time does not count");
    let resumed: RecordingInfo = call(&rs, "recording.resume", json!({ "id": id })).await.unwrap();
    assert_eq!(resumed.state, RecordingState::Recording);

    let detail: RecordingDetail = call(&rs, "recording.get", json!({ "id": id })).await.unwrap();
    assert_eq!(detail.events, [json!({ "t": 5, "kind": "click" }), json!({ "t": 6, "kind": "key" })]);
    assert_eq!(detail.frames, [RecordingFrameRef { t: 0, size: 300 }, RecordingFrameRef { t: 1200, size: 200 }, RecordingFrameRef { t: 1200, size: 250 }]);
    assert_eq!(detail.shots, [RecordingShotRef { name: "start.png".into(), size: 11 }]);
    assert_eq!((detail.info.frames, detail.info.events, detail.info.shots, detail.info.width, detail.info.height), (3, 2, 1, Some(64), Some(48)));
    let f: RecordingBytes = call(&rs, "recording.frame", json!({ "id": id, "index": 1 })).await.unwrap();
    assert_eq!(B64.decode(f.data).unwrap(), jpegs[1]);

    let stopped: RecordingInfo = call(&rs, "recording.stop", json!({ "id": id })).await.unwrap();
    assert_eq!(stopped.state, RecordingState::Processing);
    assert!(stopped.duration_ms > 1200, "the video's last slot shows the last frame");
    assert_eq!(call::<RecordingAppended>(&rs, "recording.append", json!({ "id": id })).await.unwrap_err().code, "invalid_params");
    let info = settled_rs(&rs, &id).await;
    assert_eq!((info.state, info.video.as_deref()), (RecordingState::Ready, Some("recording.mov")), "{info:?}");
    assert!(!rdir.join(store::FRAMES_BIN).exists() && !rdir.join(store::FRAMES_IDX_NEW).exists());
    let mov_bytes = fs::read(rdir.join(store::VIDEO)).unwrap();
    assert_eq!(info.video_bytes, Some(mov_bytes.len() as u64));
    assert_eq!(info.bytes, store::folder_size(&rdir));
    for (i, j) in jpegs.iter().enumerate() {
        let f: RecordingBytes = call(&rs, "recording.frame", json!({ "id": id, "index": i })).await.unwrap();
        assert_eq!(&B64.decode(f.data).unwrap(), j, "frame {i} from the video");
        let r = store::read_record(&rdir.join(store::FRAMES_IDX), i as u32).unwrap().unwrap();
        assert_eq!(&mov_bytes[r.offset as usize..r.offset as usize + j.len()], &j[..]);
    }
    assert_eq!(call::<RecordingBytes>(&rs, "recording.frame", json!({ "id": id, "index": 3 })).await.unwrap_err().code, "invalid_params");
    let head: RecordingBytes = call(&rs, "recording.read", json!({ "id": id, "file": "recording.mov", "offset": 4, "length": 4 })).await.unwrap();
    assert_eq!((B64.decode(head.data).unwrap(), head.size), (b"ftyp".to_vec(), mov_bytes.len() as u64));
    assert!(events.load(Ordering::SeqCst) >= 6, "pause, resume, stop, video, ready");

    // Reopened, the recording reads the same.
    rs.shutdown().await;
    let (rs, _) = recordings(dir.path(), Limits::default()).await;
    let list: RecordingList = call(&rs, "recording.list", json!({})).await.unwrap();
    assert_eq!(list.recordings.len(), 1);
    assert_eq!((list.recordings[0].state, list.recordings[0].frames, list.bytes), (RecordingState::Ready, 3, store::folder_size(&rdir)));
}

/// `recording.read` reads the allowed files only, in slices of at most 1 MiB.
#[tokio::test(flavor = "multi_thread")]
async fn read_slices_and_allow_list() {
    let dir = tempfile::tempdir().unwrap();
    let (rs, _) = recordings(dir.path(), Limits::default()).await;
    let info: RecordingInfo = call(&rs, "recording.start", json!({ "voice": false })).await.unwrap();
    let id = info.id;
    let png = b"\x89PNG\r\n\x1a\n0123456789".to_vec();
    let _: RecordingAppended = call(&rs, "recording.append", json!({ "id": id, "shots": [{ "name": "a.png", "data": B64.encode(&png) }] })).await.unwrap();
    let read = |file: &str, offset: u64, length: u32| call::<RecordingBytes>(&rs, "recording.read", json!({ "id": id, "file": file, "offset": offset, "length": length }));
    let part = read("shots/a.png", 8, 4).await.unwrap();
    assert_eq!((B64.decode(part.data).unwrap(), part.size), (b"0123".to_vec(), png.len() as u64));
    let tail = read("shots/a.png", 15, 100).await.unwrap();
    assert_eq!(B64.decode(tail.data).unwrap(), b"789");
    assert!(read("shots/a.png", 1000, 10).await.unwrap().data.is_empty());
    for bad in ["meta.json", "frames.bin", "events.jsonl", "shots/../meta.json", "../x", "/etc/passwd"] {
        assert_eq!(read(bad, 0, 10).await.unwrap_err().code, "invalid_params", "{bad}");
    }
    assert_eq!(read("shots/a.png", 0, (1 << 20) + 1).await.unwrap_err().code, "invalid_params");
    assert_eq!(read("voice.wav", 0, 10).await.unwrap_err().code, "not_found");
    assert_eq!(read("recording.mov", 0, 10).await.unwrap_err().code, "not_found");
    assert_eq!(call::<RecordingBytes>(&rs, "recording.read", json!({ "id": "rec_0000000000", "file": "voice.wav", "offset": 0, "length": 1 })).await.unwrap_err().code, "not_found");
}

/// Render: cuts make a `recording.mov` without them (timed from the first kept ms) in the render's
/// own folder, text files land there under sanitized names, and no cuts means the video is
/// `recording.mov` itself. The recording sent to a second host while the first upload reads:
/// that render gets a folder of its own and the first one's files stay as they are.
/// `recording.release` removes a render's folder; the next start removes what is left.
#[tokio::test(flavor = "multi_thread")]
async fn render_bundles() {
    let dir = tempfile::tempdir().unwrap();
    let (rs, _) = recordings(dir.path(), Limits::default()).await;
    let info: RecordingInfo = call(&rs, "recording.start", json!({ "voice": false })).await.unwrap();
    let id = info.id;
    let rdir = dir.path().join("recordings").join(&id);
    let early = call::<RecordingBundle>(&rs, "recording.render", json!({ "id": id })).await.unwrap_err();
    assert_eq!(early.code, "invalid_params", "not ready while recording");
    let (a, b) = (jpeg(400, 1), jpeg(500, 2));
    let _: RecordingAppended = call(&rs, "recording.append", json!({ "id": id, "frames": [frame(0, &a), frame(1500, &b)] })).await.unwrap();
    let _: RecordingInfo = call(&rs, "recording.stop", json!({ "id": id })).await.unwrap();
    let info = settled_rs(&rs, &id).await;
    let d = info.duration_ms;
    assert!(d > 1500);

    let bundle: RecordingBundle = call(
        &rs,
        "recording.render",
        json!({ "id": id, "cuts": [{ "startMs": 200, "endMs": 1000 }, { "startMs": 100, "endMs": 300 }],
                "files": [{ "name": "timeline.md", "text": "# Timeline" }, { "name": "../time line.json", "text": "{}" }] }),
    )
    .await
    .unwrap();
    assert_eq!(bundle.duration_ms, d - 900);
    let first = bundle.dir.clone().unwrap();
    assert!(first.strip_prefix("bundle/").is_some_and(store::valid_render), "{first}");
    let video = bundle.video.clone().unwrap();
    assert_eq!(video.file, format!("{first}/recording.mov"));
    assert!(Path::new(&video.path).is_absolute() && Path::new(&video.path).exists());
    let cut = fs::read(&video.path).unwrap();
    assert_eq!(video.size, cut.len() as u64);
    assert!(cut.windows(400).any(|w| w == a) && cut.windows(500).any(|w| w == b));
    let names: Vec<&str> = bundle.files.iter().map(|f| f.file.as_str()).collect();
    assert_eq!(names, [format!("{first}/timeline.md"), format!("{first}/__time_line.json")]);
    assert_eq!(fs::read_to_string(&bundle.files[0].path).unwrap(), "# Timeline");
    let read = |file: &str| call::<RecordingBytes>(&rs, "recording.read", json!({ "id": id, "file": file, "offset": 0, "length": 1 << 20 }));
    assert_eq!(B64.decode(read(&format!("{first}/timeline.md")).await.unwrap().data).unwrap(), b"# Timeline");
    assert_eq!(rs.list().recordings[0].bytes, store::folder_size(&rdir), "the bundle counts");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!((mode(&rdir.join(store::BUNDLE)), mode(&rdir.join(&first))), (0o700, 0o700));
        assert_eq!((mode(Path::new(&video.path)), mode(Path::new(&bundle.files[0].path))), (0o600, 0o600));
    }

    // Sent to another host meanwhile: a cut of its own, in a folder of its own.
    let second: RecordingBundle = call(&rs, "recording.render", json!({ "id": id, "cuts": [{ "startMs": 0, "endMs": 1200 }], "files": [{ "name": "timeline.md", "text": "2" }] }))
        .await
        .unwrap();
    let other = second.dir.clone().unwrap();
    assert_ne!(other, first);
    let again = read(&video.file).await.unwrap();
    assert_eq!((B64.decode(again.data).unwrap(), again.size), (cut.clone(), video.size), "the first upload reads its own video still");
    // That upload ended: its folder goes, the other one's stays (gone already is fine).
    let release = |dir: &str| call::<Empty>(&rs, "recording.release", json!({ "id": id, "dir": dir }));
    release(&first).await.unwrap();
    release(&first).await.unwrap();
    assert!(!rdir.join(&first).exists() && rdir.join(&other).exists());
    assert_eq!(read(&video.file).await.unwrap_err().code, "not_found");
    assert_eq!(rs.list().recordings[0].bytes, store::folder_size(&rdir));
    for bad in ["bundle", "bundle/..", "bundle/abcdefgh/x", "shots/abcdefgh", "../bundle/abcdefgh"] {
        assert_eq!(release(bad).await.unwrap_err().code, "invalid_params", "{bad}");
    }

    let plain: RecordingBundle = call(&rs, "recording.render", json!({ "id": id, "files": [{ "name": "timeline.md", "text": "again" }] })).await.unwrap();
    assert_eq!((plain.video.unwrap().file.as_str(), plain.duration_ms), ("recording.mov", d));
    assert_eq!(plain.files[0].file, format!("{}/timeline.md", plain.dir.unwrap()));

    for (params, code) in [
        (json!({ "id": id, "cuts": [{ "startMs": 0, "endMs": d }] }), "invalid_params"),
        (json!({ "id": id, "files": [{ "name": "recording.mov", "text": "" }] }), "invalid_params"),
        (json!({ "id": id, "files": [{ "name": "a.md", "text": "" }, { "name": "A.md", "text": "" }] }), "invalid_params"),
        (json!({ "id": "rec_zzzzzzzzzz" }), "not_found"),
    ] {
        assert_eq!(call::<RecordingBundle>(&rs, "recording.render", params).await.unwrap_err().code, code);
    }

    // Renders an app quit in the middle of uploading go at the next start.
    rs.shutdown().await;
    let (rs, _) = recordings(dir.path(), Limits::default()).await;
    assert!(!rdir.join(store::BUNDLE).exists());
    assert_eq!(rs.list().recordings[0].bytes, store::folder_size(&rdir));
}

/// Limits: an append past the recording's bytes, its time or the budget says so (and writes
/// nothing more); a start past the budget is refused until a recording is deleted.
#[tokio::test(flavor = "multi_thread")]
async fn caps_and_budget() {
    let dir = tempfile::tempdir().unwrap();
    let limits = Limits { max_bytes: 10_000, max_ms: 60_000, budget: 15_000 };
    let (rs, _) = recordings(dir.path(), limits).await;
    let a: RecordingInfo = call(&rs, "recording.start", json!({ "voice": false })).await.unwrap();
    let append = |id: &str, frames: Value| call::<RecordingAppended>(&rs, "recording.append", json!({ "id": id, "frames": frames }));
    assert_eq!(append(&a.id, json!([frame(0, &jpeg(4000, 1))])).await.unwrap().stop, None);
    let full = append(&a.id, json!([frame(10, &jpeg(6000, 2))])).await.unwrap();
    assert_eq!(full.stop.as_deref(), Some("This recording reached 0 GB"));
    let again = append(&a.id, json!([frame(20, &jpeg(100, 3))])).await.unwrap();
    assert_eq!((again.stop.is_some(), again.bytes), (true, full.bytes), "nothing more is written");
    let late = append(&a.id, json!([frame(60_000, &jpeg(100, 3))])).await.unwrap();
    assert!(late.stop.is_some());
    let _: RecordingInfo = call(&rs, "recording.stop", json!({ "id": a.id })).await.unwrap();
    let a = settled_rs(&rs, &a.id).await;
    assert_eq!(a.frames, 2);

    let b: RecordingInfo = call(&rs, "recording.start", json!({ "voice": false })).await.unwrap();
    let over = append(&b.id, json!([frame(0, &jpeg(5000, 4))])).await.unwrap();
    assert_eq!(over.stop.as_deref(), Some("Recordings reached 0 GB; delete some in Recordings"));
    let timed = append(&b.id, json!([frame(60_000, &jpeg(100, 5))])).await.unwrap();
    assert!(timed.stop.is_some());
    let _: RecordingInfo = call(&rs, "recording.stop", json!({ "id": b.id })).await.unwrap();
    let b = settled_rs(&rs, &b.id).await;
    assert_eq!(b.frames, 1, "frames past a limit are dropped");

    let e = call::<RecordingInfo>(&rs, "recording.start", json!({})).await.unwrap_err();
    assert_eq!(e.code, "budget_exceeded");
    assert!(e.message.starts_with("Recordings use ") && e.message.ends_with("; delete some in Recordings"), "{}", e.message);
    let list: RecordingList = call(&rs, "recording.delete", json!({ "id": a.id })).await.unwrap();
    assert_eq!((list.recordings.len(), list.budget), (1, 15_000));
    assert!(!dir.path().join("recordings").join(&a.id).exists());
    let _: RecordingInfo = call(&rs, "recording.start", json!({ "voice": false })).await.unwrap();
}

/// A still page sends no append, so no append's checks find a limit: the app core checks the
/// limits itself while recording and stops the recording at one, at its time as at the bytes the
/// voice keeps writing. Appends after that and the UI's stop are answered with the reason.
#[tokio::test(flavor = "multi_thread")]
async fn limits_stop_a_still_recording() {
    let dir = tempfile::tempdir().unwrap();
    let (rs, events) = recordings(dir.path(), Limits { max_bytes: 1 << 30, max_ms: 300, budget: 2 << 30 }).await;
    let timed: RecordingInfo = call(&rs, "recording.start", json!({ "voice": false })).await.unwrap();
    let done = settled_rs(&rs, &timed.id).await;
    assert_eq!((done.state, done.duration_ms), (RecordingState::Ready, 300), "stopped at the limit, with no stop asked for");
    assert!(events.load(Ordering::SeqCst) >= 3, "start, the stop, ready");
    let late: RecordingAppended = call(&rs, "recording.append", json!({ "id": timed.id, "events": [{ "t": 400 }] })).await.unwrap();
    assert_eq!(late.stop.as_deref(), Some("This recording reached 0 minutes"));
    let stopped: RecordingInfo = call(&rs, "recording.stop", json!({ "id": timed.id })).await.unwrap();
    assert_eq!(stopped.state, RecordingState::Ready, "the UI's stop after the app core's");
    let detail: RecordingDetail = call(&rs, "recording.get", json!({ "id": timed.id })).await.unwrap();
    assert!(detail.events.is_empty(), "nothing is written after the stop");
    assert_eq!(call::<RecordingInfo>(&rs, "recording.pause", json!({ "id": timed.id })).await.unwrap_err().code, "invalid_params");

    // The voice grows while nothing is appended (a stand-in for the microphone's file here).
    let dir = tempfile::tempdir().unwrap();
    let (rs, _) = recordings(dir.path(), Limits { max_bytes: 10_000, max_ms: 60 * 60 * 1000, budget: 2 << 30 }).await;
    let grown: RecordingInfo = call(&rs, "recording.start", json!({ "voice": false })).await.unwrap();
    fs::write(dir.path().join("recordings").join(&grown.id).join(store::VOICE), vec![0u8; 20_000]).unwrap();
    assert_eq!(settled_rs(&rs, &grown.id).await.state, RecordingState::Ready);
    let late: RecordingAppended = call(&rs, "recording.append", json!({ "id": grown.id })).await.unwrap();
    assert_eq!(late.stop.as_deref(), Some("This recording reached 0 GB"));
}

/// Deleting the recording that records stops it and frees the slot; unknown ids are not found.
#[tokio::test(flavor = "multi_thread")]
async fn delete_while_recording() {
    let dir = tempfile::tempdir().unwrap();
    let (rs, _) = recordings(dir.path(), Limits::default()).await;
    let info: RecordingInfo = call(&rs, "recording.start", json!({ "voice": false })).await.unwrap();
    let _: RecordingAppended = call(&rs, "recording.append", json!({ "id": info.id, "frames": [frame(0, &jpeg(100, 1))] })).await.unwrap();
    let list: RecordingList = call(&rs, "recording.delete", json!({ "id": info.id })).await.unwrap();
    assert!(list.recordings.is_empty() && list.bytes == 0);
    assert!(!dir.path().join("recordings").join(&info.id).exists());
    assert_eq!(call::<RecordingAppended>(&rs, "recording.append", json!({ "id": info.id })).await.unwrap_err().code, "not_found");
    assert_eq!(call::<RecordingList>(&rs, "recording.delete", json!({ "id": info.id })).await.unwrap_err().code, "not_found");
    let again: RecordingInfo = call(&rs, "recording.start", json!({ "voice": false })).await.unwrap();
    assert_eq!(again.state, RecordingState::Recording);
}

/// The app crashed while recording: the next start finds the recording `recording`, keeps what
/// its files hold whole (a frame record cut short goes) and finishes it.
#[tokio::test(flavor = "multi_thread")]
async fn crash_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let (rs, _) = recordings(dir.path(), Limits::default()).await;
    let info: RecordingInfo = call(&rs, "recording.start", json!({ "voice": false })).await.unwrap();
    let id = info.id;
    let j = jpeg(700, 7);
    let _: RecordingAppended = call(&rs, "recording.append", json!({ "id": id, "frames": [frame(0, &j), frame(2500, &j)], "events": [{ "t": 1 }] })).await.unwrap();
    drop(rs); // no shutdown: a crash
    let rdir = dir.path().join("recordings").join(&id);
    let mut idx = fs::OpenOptions::new().append(true).open(rdir.join(store::FRAMES_IDX)).unwrap();
    std::io::Write::write_all(&mut idx, &[9; 10]).unwrap();
    std::io::Write::write_all(&mut fs::OpenOptions::new().append(true).open(rdir.join(store::EVENTS)).unwrap(), b"{\"t\":").unwrap();

    let (rs, events) = recordings(dir.path(), Limits::default()).await;
    assert_eq!(rs.list().recordings[0].state, RecordingState::Recording);
    rs.recover();
    let info = settled_rs(&rs, &id).await;
    assert_eq!((info.state, info.frames, info.events, info.video.as_deref()), (RecordingState::Ready, 2, 1, Some("recording.mov")));
    assert!(info.duration_ms > 2500);
    assert!(events.load(Ordering::SeqCst) >= 2);
    let f: RecordingBytes = call(&rs, "recording.frame", json!({ "id": id, "index": 1 })).await.unwrap();
    assert_eq!(B64.decode(f.data).unwrap(), j);
    let detail: RecordingDetail = call(&rs, "recording.get", json!({ "id": id })).await.unwrap();
    assert_eq!(detail.events, [json!({ "t": 1 })]);
}

/// Waits until the recording's transcription ended.
async fn transcript_settled(rs: &Arc<Recordings>, id: &str) -> RecordingTranscript {
    for _ in 0..1000 {
        let t = rs.list().recordings.into_iter().find(|r| r.id == id).expect("listed").transcript;
        if !matches!(t.state, TranscriptState::Waiting | TranscriptState::Running) {
            return t;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{id}: the transcription did not end");
}

/// The app ended (crashed, out of memory say) in a recording's transcription: the next start runs
/// it again, but one that ended the app twice fails instead of ending it at every start;
/// `recording.transcribe` still runs it on request.
#[tokio::test(flavor = "multi_thread")]
async fn a_transcription_that_ends_the_app_is_not_run_at_every_start() {
    let dir = tempfile::tempdir().unwrap();
    let (rs, _) = recordings(dir.path(), Limits::default()).await;
    let info: RecordingInfo = call(&rs, "recording.start", json!({ "voice": false })).await.unwrap();
    let id = info.id;
    let _: RecordingInfo = call(&rs, "recording.stop", json!({ "id": id })).await.unwrap();
    settled_rs(&rs, &id).await;
    rs.shutdown().await;
    let rdir = dir.path().join("recordings").join(&id);
    // What a crash in its transcription leaves: running, and the runs that never ended.
    let crashed = |runs: u32| {
        let mut meta = store::read_meta(&rdir).unwrap();
        meta.info.voice = RecordingVoice { state: VoiceState::On, message: None, offset_ms: Some(0), duration_ms: Some(1000) };
        meta.info.transcript = RecordingTranscript { state: TranscriptState::Running, progress: Some(0.5), message: None, segments: Vec::new() };
        meta.transcribe_runs = runs;
        fs::write(rdir.join(store::META), serde_json::to_vec(&meta).unwrap()).unwrap();
    };

    crashed(1);
    let (rs, _) = recordings(dir.path(), Limits::default()).await;
    rs.recover();
    assert_ne!(transcript_settled(&rs, &id).await.message.as_deref(), Some(TRANSCRIBE_ENDED_APP), "it ran again");
    rs.shutdown().await;
    assert_eq!(store::read_meta(&rdir).unwrap().transcribe_runs, 0, "and ended");

    crashed(TRANSCRIBE_RUNS);
    let (rs, _) = recordings(dir.path(), Limits::default()).await;
    rs.recover();
    let t = transcript_settled(&rs, &id).await;
    assert_eq!((t.state, t.message.as_deref()), (TranscriptState::Failed, Some(TRANSCRIBE_ENDED_APP)));
    let again: RecordingInfo = call(&rs, "recording.transcribe", json!({ "id": id })).await.unwrap();
    assert_eq!(again.transcript.state, TranscriptState::Waiting);
    assert_ne!(transcript_settled(&rs, &id).await.message.as_deref(), Some(TRANSCRIBE_ENDED_APP), "asked for, it runs");
    rs.shutdown().await;
}

/// Without the `voice` feature a recording has no voice and says so; there is nothing to
/// transcribe.
#[cfg(not(feature = "voice"))]
#[tokio::test(flavor = "multi_thread")]
async fn no_voice_in_this_build() {
    let dir = tempfile::tempdir().unwrap();
    let (rs, _) = recordings(dir.path(), Limits::default()).await;
    let info: RecordingInfo = call(&rs, "recording.start", json!({})).await.unwrap();
    assert_eq!((info.voice.state, info.voice.message.as_deref()), (VoiceState::Unavailable, Some(voice::UNAVAILABLE)));
    assert_eq!(info.transcript.state, TranscriptState::Unavailable);
    let _: RecordingInfo = call(&rs, "recording.stop", json!({ "id": info.id })).await.unwrap();
    let done = settled_rs(&rs, &info.id).await;
    assert_eq!((done.state, done.video), (RecordingState::Ready, None), "neither frames nor voice: no video");
    assert_eq!(call::<RecordingInfo>(&rs, "recording.transcribe", json!({ "id": info.id })).await.unwrap_err().code, "invalid_params");
}

/// With the voice feature, through a microphone (the tests' fake one, a tone in real time): the
/// voice is recorded from where audio started, goes into the video, and the transcription ends
/// `noModel` in a data dir without models; `recording.transcribe` runs it again.
#[cfg(feature = "voice")]
#[tokio::test(flavor = "multi_thread")]
async fn voice_through_the_microphone() {
    let dir = tempfile::tempdir().unwrap();
    crate::dictation::test_microphone();

    let (rs, _) = recordings(dir.path(), Limits::default()).await;
    let info: RecordingInfo = call(&rs, "recording.start", json!({})).await.unwrap();
    assert_eq!(info.voice.state, VoiceState::On, "{:?}", info.voice);
    let id = info.id;
    let mut offset = None;
    for _ in 0..300 {
        let _: RecordingAppended = call(&rs, "recording.append", json!({ "id": id })).await.unwrap();
        offset = rs.list().recordings[0].voice.offset_ms;
        if offset.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(offset.is_some(), "audio flows: the voice's start is known while recording");
    let _: RecordingAppended = call(&rs, "recording.append", json!({ "id": id, "frames": [frame(0, &jpeg(100, 1))] })).await.unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    let stopped: RecordingInfo = call(&rs, "recording.stop", json!({ "id": id })).await.unwrap();
    assert_eq!(stopped.transcript.state, TranscriptState::Waiting);
    let info = settled_rs(&rs, &id).await;
    assert_eq!((info.state, info.voice.state), (RecordingState::Ready, VoiceState::On), "{info:?}");
    assert!(info.voice.duration_ms.is_some_and(|ms| ms >= 400), "{:?}", info.voice);
    assert_eq!((info.transcript.state, info.transcript.message.as_deref()), (TranscriptState::NoModel, Some(NO_MODEL)));
    let mov = fs::read(dir.path().join("recordings").join(&id).join(store::VIDEO)).unwrap();
    assert!(mov.windows(4).any(|w| w == b"sowt") && mov.windows(4).any(|w| w == b"jpeg"), "voice and video tracks");

    let again: RecordingInfo = call(&rs, "recording.transcribe", json!({ "id": id })).await.unwrap();
    assert_eq!(again.transcript.state, TranscriptState::Waiting);
    for _ in 0..500 {
        if !matches!(rs.list().recordings[0].transcript.state, TranscriptState::Waiting | TranscriptState::Running) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(rs.list().recordings[0].transcript.state, TranscriptState::NoModel);
}

// ───────────────────────────── through the engine ─────────────────────────────

struct NullPlatform;
impl crate::platform::Platform for NullPlatform {
    fn notify(&self, _: Option<&HostProfile>, _: &Notification, _: crate::platform::NotifyStyle) {}
    fn open_external(&self, _: &str) -> Result<(), ApiError> {
        Ok(())
    }
    fn set_keep_alive(&self, _: bool) {}
    fn set_badge(&self, _: crate::platform::BadgeState) {}
    fn device_name(&self) -> String {
        "test-device".into()
    }
}

async fn engine(dir: &Path) -> (crate::engine::Engine, tokio::sync::broadcast::Receiver<AppEvent>) {
    let cfg = crate::engine::EngineConfig {
        data_dir: dir.to_path_buf(),
        platform_name: "linux".into(),
        client_app: "teleflock-test".into(),
        version: "0.0.0".into(),
        hostd_bins_override: None,
    };
    crate::engine::Engine::start(cfg, Arc::new(NullPlatform)).await
}

async fn ecall<T: DeserializeOwned>(engine: &crate::engine::Engine, method: &str, params: Value) -> Result<T, ApiError> {
    engine.call(None, method, params).await.map(|v| serde_json::from_value(v).unwrap())
}

/// The app methods and `AppEvent::Recordings` through the engine; quitting while recording
/// leaves the recording to the next start, which finishes it.
#[tokio::test(flavor = "multi_thread")]
async fn engine_round_trip_and_recovery_after_quit() {
    let dir = tempfile::tempdir().unwrap();
    let (e, mut rx) = engine(dir.path()).await;
    let info: RecordingInfo = ecall(&e, "recording.start", json!({ "title": "Checkout", "voice": false })).await.unwrap();
    let id = info.id.clone();
    let j = jpeg(321, 4);
    let out: RecordingAppended = ecall(&e, "recording.append", json!({ "id": id, "frames": [frame(0, &j), frame(800, &jpeg(123, 5))] })).await.unwrap();
    assert!(out.stop.is_none());
    let updated: RecordingInfo = ecall(&e, "recording.update", json!({ "id": id, "title": "Checkout fails", "doc": { "cuts": [] } })).await.unwrap();
    assert_eq!((updated.title.as_str(), updated.doc), ("Checkout fails", Some(json!({ "cuts": [] }))));
    assert_eq!(ecall::<RecordingInfo>(&e, "recording.update", json!({ "id": id, "title": " " })).await.unwrap_err().code, "invalid_params");
    let mut seen = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if let AppEvent::Recordings { recordings } = ev {
            seen.push(recordings);
        }
    }
    assert_eq!(seen.len(), 2, "start and update");
    assert_eq!(seen[1].recordings[0].title, "Checkout fails");
    e.shutdown().await;

    let (e, _rx) = engine(dir.path()).await;
    let mut info = None;
    for _ in 0..1000 {
        let list: RecordingList = ecall(&e, "recording.list", json!({})).await.unwrap();
        if list.recordings[0].state == RecordingState::Ready {
            info = Some(list.recordings[0].clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let info = info.expect("finished at the next start");
    assert_eq!((info.title.as_str(), info.frames, info.video.as_deref()), ("Checkout fails", 2, Some("recording.mov")));
    assert!(info.duration_ms > 800);
    let f: RecordingBytes = ecall(&e, "recording.frame", json!({ "id": id, "index": 0 })).await.unwrap();
    assert_eq!(B64.decode(f.data).unwrap(), j);
    let list: RecordingList = ecall(&e, "recording.delete", json!({ "id": id })).await.unwrap();
    assert!(list.recordings.is_empty());
    e.shutdown().await;
}

/// Recordings are this user's only: the folders 0700 (a recordings folder made readable before
/// is tightened), every file 0600, from the first append to the video.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn files_only_this_user_reads() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("recordings");
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    let (rs, _) = recordings(dir.path(), Limits::default()).await;
    let info: RecordingInfo = call(&rs, "recording.start", json!({ "voice": false })).await.unwrap();
    let id = info.id;
    let rdir = root.join(&id);
    let shot = json!([{ "name": "start.png", "data": B64.encode(b"\x89PNG\r\n\x1a\nxyz") }]);
    let _: RecordingAppended = call(&rs, "recording.append", json!({ "id": id, "frames": [frame(0, &jpeg(300, 1)), frame(900, &jpeg(200, 2))], "events": [{ "t": 5 }], "shots": shot })).await.unwrap();
    assert_eq!((mode(&root), mode(&rdir), mode(&rdir.join(store::SHOTS))), (0o700, 0o700, 0o700));
    for f in [store::META, store::FRAMES_BIN, store::FRAMES_IDX, store::EVENTS, "shots/start.png"] {
        assert_eq!(mode(&rdir.join(f)), 0o600, "{f}");
    }
    let _: RecordingInfo = call(&rs, "recording.stop", json!({ "id": id })).await.unwrap();
    assert_eq!(settled_rs(&rs, &id).await.state, RecordingState::Ready);
    for f in [store::META, store::FRAMES_IDX, store::VIDEO] {
        assert_eq!(mode(&rdir.join(f)), 0o600, "{f} after the video");
    }
    rs.shutdown().await;
}
