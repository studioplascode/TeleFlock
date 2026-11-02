//! The part of the sherpa-onnx C API (`sherpa-onnx/c-api/c-api.h`, v2.0.1) this crate uses:
//! offline recognizers, the Silero voice activity detector and the version string. Layouts follow
//! the header field by field (every struct is passed by pointer and embeds the others by value).
//! Unset pointers are null and unset numbers 0: the library substitutes its defaults for both.
#![allow(non_snake_case, dead_code)]

use std::os::raw::{c_char, c_float};

#[repr(C)]
pub struct FeatureConfig {
    pub sample_rate: i32,
    pub feature_dim: i32,
}

#[repr(C)]
pub struct OfflineTransducerModelConfig {
    pub encoder: *const c_char,
    pub decoder: *const c_char,
    pub joiner: *const c_char,
}

#[repr(C)]
pub struct OfflineParaformerModelConfig {
    pub model: *const c_char,
}

#[repr(C)]
pub struct OfflineNemoEncDecCtcModelConfig {
    pub model: *const c_char,
}

#[repr(C)]
pub struct OfflineWhisperModelConfig {
    pub encoder: *const c_char,
    pub decoder: *const c_char,
    pub language: *const c_char,
    pub task: *const c_char,
    pub tail_paddings: i32,
    pub enable_token_timestamps: i32,
    pub enable_segment_timestamps: i32,
}

#[repr(C)]
pub struct OfflineCanaryModelConfig {
    pub encoder: *const c_char,
    pub decoder: *const c_char,
    pub src_lang: *const c_char,
    pub tgt_lang: *const c_char,
    pub use_pnc: i32,
}

#[repr(C)]
pub struct OfflineCohereTranscribeModelConfig {
    pub encoder: *const c_char,
    pub decoder: *const c_char,
    pub language: *const c_char,
    pub use_punct: i32,
    pub use_itn: i32,
}

#[repr(C)]
pub struct OfflineFireRedAsrModelConfig {
    pub encoder: *const c_char,
    pub decoder: *const c_char,
}

#[repr(C)]
pub struct OfflineFireRedAsrCtcModelConfig {
    pub model: *const c_char,
}

#[repr(C)]
pub struct OfflineMoonshineModelConfig {
    pub preprocessor: *const c_char,
    pub encoder: *const c_char,
    pub uncached_decoder: *const c_char,
    pub cached_decoder: *const c_char,
    pub merged_decoder: *const c_char,
}

#[repr(C)]
pub struct OfflineTdnnModelConfig {
    pub model: *const c_char,
}

#[repr(C)]
pub struct OfflineLMConfig {
    pub model: *const c_char,
    pub scale: c_float,
}

#[repr(C)]
pub struct OfflineSenseVoiceModelConfig {
    pub model: *const c_char,
    pub language: *const c_char,
    pub use_itn: i32,
}

#[repr(C)]
pub struct OfflineDolphinModelConfig {
    pub model: *const c_char,
}

#[repr(C)]
pub struct OfflineZipformerCtcModelConfig {
    pub model: *const c_char,
}

#[repr(C)]
pub struct OfflineWenetCtcModelConfig {
    pub model: *const c_char,
}

#[repr(C)]
pub struct OfflineOmnilingualAsrCtcModelConfig {
    pub model: *const c_char,
}

#[repr(C)]
pub struct OfflineFunASRNanoModelConfig {
    pub encoder_adaptor: *const c_char,
    pub llm: *const c_char,
    pub embedding: *const c_char,
    pub tokenizer: *const c_char,
    pub system_prompt: *const c_char,
    pub user_prompt: *const c_char,
    pub max_new_tokens: i32,
    pub temperature: c_float,
    pub top_p: c_float,
    pub seed: i32,
    pub language: *const c_char,
    pub itn: i32,
    pub hotwords: *const c_char,
}

#[repr(C)]
pub struct OfflineQwen3AsrModelConfig {
    pub conv_frontend: *const c_char,
    pub encoder: *const c_char,
    pub decoder: *const c_char,
    pub tokenizer: *const c_char,
    pub max_total_len: i32,
    pub max_new_tokens: i32,
    pub temperature: c_float,
    pub top_p: c_float,
    pub seed: i32,
    pub hotwords: *const c_char,
}

#[repr(C)]
pub struct OfflineMedAsrCtcModelConfig {
    pub model: *const c_char,
}

#[repr(C)]
pub struct OfflineModelConfig {
    pub transducer: OfflineTransducerModelConfig,
    pub paraformer: OfflineParaformerModelConfig,
    pub nemo_ctc: OfflineNemoEncDecCtcModelConfig,
    pub whisper: OfflineWhisperModelConfig,
    pub tdnn: OfflineTdnnModelConfig,
    pub tokens: *const c_char,
    pub num_threads: i32,
    pub debug: i32,
    pub provider: *const c_char,
    pub model_type: *const c_char,
    pub modeling_unit: *const c_char,
    pub bpe_vocab: *const c_char,
    pub telespeech_ctc: *const c_char,
    pub sense_voice: OfflineSenseVoiceModelConfig,
    pub moonshine: OfflineMoonshineModelConfig,
    pub fire_red_asr: OfflineFireRedAsrModelConfig,
    pub dolphin: OfflineDolphinModelConfig,
    pub zipformer_ctc: OfflineZipformerCtcModelConfig,
    pub canary: OfflineCanaryModelConfig,
    pub wenet_ctc: OfflineWenetCtcModelConfig,
    pub omnilingual: OfflineOmnilingualAsrCtcModelConfig,
    pub medasr: OfflineMedAsrCtcModelConfig,
    pub funasr_nano: OfflineFunASRNanoModelConfig,
    pub fire_red_asr_ctc: OfflineFireRedAsrCtcModelConfig,
    pub qwen3_asr: OfflineQwen3AsrModelConfig,
    pub cohere_transcribe: OfflineCohereTranscribeModelConfig,
}

#[repr(C)]
pub struct HomophoneReplacerConfig {
    pub dict_dir: *const c_char,
    pub lexicon: *const c_char,
    pub rule_fsts: *const c_char,
}

#[repr(C)]
pub struct OfflineCtcFstDecoderConfig {
    pub graph: *const c_char,
    pub max_active: i32,
}

#[repr(C)]
pub struct OfflineRecognizerConfig {
    pub feat_config: FeatureConfig,
    pub model_config: OfflineModelConfig,
    pub lm_config: OfflineLMConfig,
    pub decoding_method: *const c_char,
    pub max_active_paths: i32,
    pub hotwords_file: *const c_char,
    pub hotwords_score: c_float,
    pub rule_fsts: *const c_char,
    pub rule_fars: *const c_char,
    pub blank_penalty: c_float,
    pub hr: HomophoneReplacerConfig,
    pub ctc_fst_decoder_config: OfflineCtcFstDecoderConfig,
}

#[repr(C)]
pub struct SileroVadModelConfig {
    pub model: *const c_char,
    pub threshold: c_float,
    pub min_silence_duration: c_float,
    pub min_speech_duration: c_float,
    pub window_size: i32,
    pub max_speech_duration: c_float,
}

#[repr(C)]
pub struct TenVadModelConfig {
    pub model: *const c_char,
    pub threshold: c_float,
    pub min_silence_duration: c_float,
    pub min_speech_duration: c_float,
    pub window_size: i32,
    pub max_speech_duration: c_float,
}

#[repr(C)]
pub struct VadModelConfig {
    pub silero_vad: SileroVadModelConfig,
    pub sample_rate: i32,
    pub num_threads: i32,
    pub provider: *const c_char,
    pub debug: i32,
    pub ten_vad: TenVadModelConfig,
}

#[repr(C)]
pub struct SpeechSegment {
    pub start: i64,
    pub samples: *mut c_float,
    pub n: i32,
}

/// Opaque handles.
#[repr(C)]
pub struct OfflineRecognizer {
    _private: [u8; 0],
}
#[repr(C)]
pub struct OfflineStream {
    _private: [u8; 0],
}
#[repr(C)]
pub struct VoiceActivityDetector {
    _private: [u8; 0],
}

unsafe extern "C" {
    pub fn SherpaOnnxGetVersionStr() -> *const c_char;

    pub fn SherpaOnnxCreateOfflineRecognizer(config: *const OfflineRecognizerConfig) -> *const OfflineRecognizer;
    pub fn SherpaOnnxDestroyOfflineRecognizer(recognizer: *const OfflineRecognizer);
    pub fn SherpaOnnxCreateOfflineStream(recognizer: *const OfflineRecognizer) -> *const OfflineStream;
    pub fn SherpaOnnxDestroyOfflineStream(stream: *const OfflineStream);
    pub fn SherpaOnnxAcceptWaveformOffline(stream: *const OfflineStream, sample_rate: i32, samples: *const c_float, n: i32);
    pub fn SherpaOnnxOfflineStreamSetOption(stream: *const OfflineStream, key: *const c_char, value: *const c_char);
    pub fn SherpaOnnxDecodeOfflineStream(recognizer: *const OfflineRecognizer, stream: *const OfflineStream);
    pub fn SherpaOnnxGetOfflineStreamResultAsJson(stream: *const OfflineStream) -> *const c_char;
    pub fn SherpaOnnxDestroyOfflineStreamResultJson(json: *const c_char);

    pub fn SherpaOnnxCreateVoiceActivityDetector(config: *const VadModelConfig, buffer_size_in_seconds: c_float) -> *const VoiceActivityDetector;
    pub fn SherpaOnnxDestroyVoiceActivityDetector(p: *const VoiceActivityDetector);
    pub fn SherpaOnnxVoiceActivityDetectorAcceptWaveform(p: *const VoiceActivityDetector, samples: *const c_float, n: i32);
    pub fn SherpaOnnxVoiceActivityDetectorEmpty(p: *const VoiceActivityDetector) -> i32;
    pub fn SherpaOnnxVoiceActivityDetectorDetected(p: *const VoiceActivityDetector) -> i32;
    pub fn SherpaOnnxVoiceActivityDetectorPop(p: *const VoiceActivityDetector);
    pub fn SherpaOnnxVoiceActivityDetectorClear(p: *const VoiceActivityDetector);
    pub fn SherpaOnnxVoiceActivityDetectorFront(p: *const VoiceActivityDetector) -> *const SpeechSegment;
    pub fn SherpaOnnxDestroySpeechSegment(p: *const SpeechSegment);
    pub fn SherpaOnnxVoiceActivityDetectorReset(p: *const VoiceActivityDetector);
    pub fn SherpaOnnxVoiceActivityDetectorFlush(p: *const VoiceActivityDetector);
}
