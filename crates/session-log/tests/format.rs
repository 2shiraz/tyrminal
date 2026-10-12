//! Recording format: round trip, and every way a file can be cut, altered or swapped.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use proptest::prelude::*;
use tyrminal_session_log::{
    Completeness, EndReason, Event, HEADER_LEN, LogError, LogIdentity, LogWriter, MIN_LOG_LIMIT, WriteStatus, read_log,
};

const KEY: [u8; 32] = [7; 32];
const OTHER_KEY: [u8; 32] = [8; 32];
const ID: LogIdentity = LogIdentity { vault_id: [1; 16], log_id: [2; 16], key_version: 1 };
const STARTED: u64 = 1_760_000_000_000;
const LIMIT: u64 = 8 * 1024 * 1024;

/// A recording of several flushes: returns the file and the events a reader should return.
fn recording(identity: LogIdentity, finish: bool) -> (Vec<u8>, Vec<Event>) {
    let mut writer = LogWriter::start(&KEY, identity, STARTED, 80, 24, LIMIT, Vec::new()).unwrap();
    let mut expected = Vec::new();
    for i in 0..6u32 {
        let data = format!("line {i}: canary-output-{i}\r\n").into_bytes();
        assert_eq!(writer.output(i * 10, &data).unwrap(), WriteStatus::Recording);
        expected.push(Event::Output { at_ms: i * 10, data });
        if i == 3 {
            writer.resize(35, 120, 40).unwrap();
            expected.push(Event::Resize { at_ms: 35, cols: 120, rows: 40 });
        }
        writer.flush().unwrap();
    }
    if !finish {
        // A writer that is never finished: what is on disk is everything flushed so far.
        return (writer.into_inner(), expected);
    }
    let bytes = writer.finish(70, EndReason::Closed).unwrap();
    expected.push(Event::End { at_ms: 70, reason: EndReason::Closed });
    (bytes, expected)
}

/// Byte ranges of every chunk frame after the header.
fn frames(bytes: &[u8]) -> Vec<std::ops::Range<usize>> {
    let mut at = HEADER_LEN;
    let mut out = Vec::new();
    while at < bytes.len() {
        let len = u32::from_be_bytes(bytes[at + 1..at + 5].try_into().unwrap()) as usize;
        out.push(at..at + 5 + len);
        at += 5 + len;
    }
    out
}

/// Every event `got` returned is the same as the original at that position.
fn is_prefix(got: &[Event], all: &[Event]) -> bool {
    got.len() <= all.len() && got.iter().zip(all).all(|(a, b)| a == b)
}

#[test]
fn a_finished_recording_reads_back_exactly() {
    let (bytes, expected) = recording(ID, true);
    let playback = read_log(&KEY, &ID, &bytes).unwrap();
    assert_eq!((playback.started_unix_ms, playback.cols, playback.rows), (STARTED, 80, 24));
    assert_eq!(playback.events, expected);
    assert_eq!(playback.completeness, Completeness::Complete(EndReason::Closed));
}

#[test]
fn the_file_holds_no_plaintext_output() {
    let (bytes, _) = recording(ID, true);
    let text = String::from_utf8_lossy(&bytes);
    assert!(!text.contains("canary-output"), "output must only be stored encrypted");
    assert!(!bytes.windows(4).any(|w| w == b"line"));
}

#[test]
fn an_unfinished_recording_reads_as_incomplete_with_everything_flushed() {
    let (bytes, expected) = recording(ID, false);
    let playback = read_log(&KEY, &ID, &bytes).unwrap();
    assert_eq!(playback.events, expected);
    assert_eq!(playback.completeness, Completeness::Incomplete);
}

#[test]
fn a_cut_at_any_byte_never_reads_as_complete_and_only_shows_original_events() {
    let (bytes, expected) = recording(ID, true);
    for cut in 0..bytes.len() {
        match read_log(&KEY, &ID, &bytes[..cut]) {
            Err(LogError::NotALog | LogError::Unreadable) => {}
            Err(other) => panic!("cut at {cut}: unexpected {other:?}"),
            Ok(playback) => {
                assert_ne!(playback.completeness, Completeness::Complete(EndReason::Closed), "cut at {cut}");
                assert!(is_prefix(&playback.events, &expected), "cut at {cut}");
            }
        }
    }
}

#[test]
fn a_changed_byte_anywhere_is_detected() {
    let (bytes, expected) = recording(ID, true);
    for at in 0..bytes.len() {
        let mut altered = bytes.clone();
        altered[at] ^= 0x01;
        match read_log(&KEY, &ID, &altered) {
            Err(_) => {}
            Ok(playback) => {
                assert_ne!(playback.completeness, Completeness::Complete(EndReason::Closed), "byte {at}");
                assert!(is_prefix(&playback.events, &expected), "byte {at}");
            }
        }
    }
}

#[test]
fn reordered_or_dropped_chunks_are_detected() {
    let (bytes, expected) = recording(ID, true);
    let frames = frames(&bytes);
    assert!(frames.len() >= 5);
    let rebuild = |order: &[usize]| {
        let mut out = bytes[..HEADER_LEN].to_vec();
        for &i in order {
            out.extend_from_slice(&bytes[frames[i].clone()]);
        }
        out
    };
    let last = frames.len() - 1;
    let mut swapped: Vec<usize> = (0..frames.len()).collect();
    swapped.swap(2, 3);
    let mut dropped: Vec<usize> = (0..frames.len()).collect();
    dropped.remove(2);
    let mut early_end: Vec<usize> = (0..3).collect();
    early_end.push(last);
    let mut repeated: Vec<usize> = (0..frames.len()).collect();
    repeated.insert(2, 1);
    for order in [swapped, dropped, early_end, repeated] {
        let playback = read_log(&KEY, &ID, &rebuild(&order)).unwrap();
        assert_eq!(playback.completeness, Completeness::Damaged, "{order:?}");
        assert!(is_prefix(&playback.events, &expected), "{order:?}");
    }
}

#[test]
fn trailing_bytes_after_the_final_chunk_are_detected() {
    let (mut bytes, expected) = recording(ID, true);
    bytes.extend_from_slice(&[0; 40]);
    let playback = read_log(&KEY, &ID, &bytes).unwrap();
    assert_eq!(playback.completeness, Completeness::Damaged);
    assert!(is_prefix(&playback.events, &expected));
}

#[test]
fn marking_an_ordinary_chunk_as_final_or_the_reverse_is_detected() {
    let (bytes, _) = recording(ID, true);
    let frames = frames(&bytes);
    let mut as_last = bytes[..frames[2].end].to_vec();
    as_last[frames[2].start] = 1;
    assert_eq!(read_log(&KEY, &ID, &as_last).unwrap().completeness, Completeness::Damaged);
    let mut as_next = bytes.clone();
    as_next[frames.last().unwrap().start] = 0;
    assert_ne!(read_log(&KEY, &ID, &as_next).unwrap().completeness, Completeness::Complete(EndReason::Closed));
}

#[test]
fn chunks_from_another_recording_are_refused() {
    let other_id = LogIdentity { log_id: [9; 16], ..ID };
    let (ours, _) = recording(ID, true);
    let (theirs, _) = recording(other_id, true);
    // Another log's whole file, presented as ours.
    assert_eq!(read_log(&KEY, &ID, &theirs), Err(LogError::WrongLog));
    // Its header rewritten to claim our identity: nothing authenticates.
    let mut relabelled = ours[..HEADER_LEN].to_vec();
    relabelled.extend_from_slice(&theirs[HEADER_LEN..]);
    assert_eq!(read_log(&KEY, &ID, &relabelled), Err(LogError::Unreadable));
    // One of its chunks spliced into ours.
    let (ours_frames, theirs_frames) = (frames(&ours), frames(&theirs));
    let mut spliced = ours[..ours_frames[2].start].to_vec();
    spliced.extend_from_slice(&theirs[theirs_frames[2].clone()]);
    spliced.extend_from_slice(&ours[ours_frames[3].start..]);
    assert_eq!(read_log(&KEY, &ID, &spliced).unwrap().completeness, Completeness::Damaged);
}

#[test]
fn the_wrong_key_or_identity_opens_nothing() {
    let (bytes, _) = recording(ID, true);
    assert_eq!(read_log(&OTHER_KEY, &ID, &bytes), Err(LogError::Unreadable));
    assert_eq!(read_log(&KEY, &LogIdentity { key_version: 2, ..ID }, &bytes), Err(LogError::WrongLog));
    assert_eq!(read_log(&KEY, &LogIdentity { vault_id: [3; 16], ..ID }, &bytes), Err(LogError::WrongLog));
    assert_eq!(read_log(&KEY, &ID, b"not a recording at all, just text"), Err(LogError::NotALog));
}

#[test]
fn the_size_limit_ends_the_recording_cleanly_and_is_never_exceeded() {
    let limit = MIN_LOG_LIMIT + 8 * 1024;
    let mut writer = LogWriter::start(&KEY, ID, STARTED, 80, 24, limit, Vec::new()).unwrap();
    let mut status = WriteStatus::Recording;
    let mut sent = 0u32;
    while status == WriteStatus::Recording {
        status = writer.output(sent, &[b'x'; 700]).unwrap();
        writer.flush().unwrap();
        sent += 1;
        assert!(sent < 100, "the limit must stop recording");
    }
    assert!(writer.is_finished());
    assert_eq!(writer.output(sent, b"more"), Err(LogError::Finished));
    assert!(writer.written() <= limit, "{} > {limit}", writer.written());
    let playback = read_log(&KEY, &ID, &writer.into_inner()).unwrap();
    assert_eq!(playback.completeness, Completeness::Complete(EndReason::SizeLimit));
    assert!(LogWriter::start(&KEY, ID, STARTED, 80, 24, MIN_LOG_LIMIT - 1, Vec::new()).is_err());
}

#[test]
fn file_size_reveals_only_padded_volume() {
    let size_for = |len: usize| {
        let mut writer = LogWriter::start(&KEY, ID, STARTED, 80, 24, LIMIT, Vec::new()).unwrap();
        writer.output(1, &vec![b'a'; len]).unwrap();
        writer.finish(2, EndReason::Closed).unwrap().len()
    };
    assert_eq!(size_for(1), size_for(900), "outputs within one pad block are the same size");
    assert!(size_for(5000) > size_for(900));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn any_output_round_trips(
        writes in proptest::collection::vec((0u32..10_000, proptest::collection::vec(any::<u8>(), 0..3000), any::<bool>()), 0..40)
    ) {
        let mut writer = LogWriter::start(&KEY, ID, STARTED, 100, 30, LIMIT, Vec::new()).unwrap();
        let mut expected = Vec::new();
        for (at, data, flush) in &writes {
            writer.output(*at, data).unwrap();
            if !data.is_empty() {
                expected.push(Event::Output { at_ms: *at, data: data.clone() });
            }
            if *flush {
                writer.flush().unwrap();
            }
        }
        let bytes = writer.finish(10_001, EndReason::Stopped).unwrap();
        expected.push(Event::End { at_ms: 10_001, reason: EndReason::Stopped });
        let playback = read_log(&KEY, &ID, &bytes).unwrap();
        prop_assert_eq!(playback.completeness, Completeness::Complete(EndReason::Stopped));
        prop_assert_eq!(playback.events, expected);
    }

    #[test]
    fn arbitrary_bytes_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let _ = read_log(&KEY, &ID, &bytes);
        let mut with_header = recording(ID, true).0[..HEADER_LEN].to_vec();
        with_header.extend_from_slice(&bytes);
        let _ = read_log(&KEY, &ID, &with_header);
    }
}
