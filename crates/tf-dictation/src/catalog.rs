//! The speech models TeleFlock offers: sherpa-onnx exports on Hugging Face, every file pinned by
//! repository commit, size and sha256. Measurements behind the notes: docs/architecture.md
//! §6.16 (a Ryzen 7 5800X, 4 threads; FLEURS read speech and synthetic dictation).

/// How sherpa-onnx loads a model (its file names follow from it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// NeMo TDT transducer: `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`.
    NemoTransducer,
    /// NeMo Canary: `encoder.int8.onnx`, `decoder.int8.onnx`; needs the spoken language.
    Canary,
    /// Whisper: `<prefix>-encoder.int8.onnx`, `<prefix>-decoder.int8.onnx`, `<prefix>-tokens.txt`.
    Whisper { prefix: &'static str },
    /// Moonshine v2: `encoder_model.ort`, `decoder_model_merged.ort`.
    MoonshineV2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct File {
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceClass {
    Desktop,
    Phone,
}

impl DeviceClass {
    pub fn current() -> Self {
        if cfg!(any(target_os = "android", target_os = "ios")) { Self::Phone } else { Self::Desktop }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Phone => "phone",
        }
    }
}

#[derive(Debug)]
pub struct Model {
    pub id: &'static str,
    pub name: &'static str,
    pub summary: &'static str,
    pub languages: &'static str,
    /// ISO 639-1 codes it can be told to expect; the first is its fallback.
    pub language_codes: &'static [&'static str],
    /// Detects the spoken language itself.
    pub auto_language: bool,
    pub kind: Kind,
    /// Hugging Face repository and the commit its files are pinned to.
    pub repo: &'static str,
    pub commit: &'static str,
    pub files: &'static [File],
    pub ram_mb: u32,
    /// 1 (lowest) – 5.
    pub speed: u8,
    pub accuracy: u8,
    pub notes: &'static str,
    pub recommended: &'static [DeviceClass],
}

impl Model {
    pub fn size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    pub fn url(&self, file: &File) -> String {
        format!("https://huggingface.co/{}/resolve/{}/{}", self.repo, self.commit, file.name)
    }

    pub fn recommended_for(&self, device: DeviceClass) -> bool {
        self.recommended.contains(&device)
    }

    /// Listens for a chosen language (Whisper keeps to it, Canary needs one); the others detect
    /// it and ignore the choice.
    pub fn takes_language(&self) -> bool {
        matches!(self.kind, Kind::Whisper { .. } | Kind::Canary)
    }

    /// The language to tell the model: the user's choice (`auto` or a code), else the device
    /// locale's language when the model needs one. `None`: the model detects it.
    pub fn language_for(&self, chosen: &str, locale: Option<&str>) -> Option<&'static str> {
        let known = |code: &str| self.language_codes.iter().copied().find(|c| *c == code);
        if chosen != "auto" {
            return known(chosen).or(if self.auto_language { None } else { Some(self.language_codes[0]) });
        }
        if self.auto_language {
            return None;
        }
        let from_locale = locale.and_then(|l| l.split(['-', '_']).next()).map(str::to_ascii_lowercase);
        Some(from_locale.as_deref().and_then(known).unwrap_or(self.language_codes[0]))
    }
}

const WHISPER_LANGS: &[&str] = &[
    "en", "de", "fr", "es", "it", "pt", "nl", "pl", "cs", "sk", "sl", "hr", "sr", "bs", "bg", "ro", "hu", "da", "sv", "no", "nb", "fi", "et", "lv",
    "lt", "el", "uk", "ru", "be", "tr", "ca", "gl", "eu", "is", "ga", "cy", "mt", "sq", "mk", "ja", "zh", "ko", "vi", "th", "id", "ms", "tl",
    "hi", "ur", "bn", "ta", "te", "mr", "gu", "kn", "ml", "pa", "ne", "si", "ar", "he", "fa", "sw", "af", "az", "kk", "uz", "hy", "ka", "mn",
];

const WHISPER_TOKENS: File = File {
    name: "",
    size: 816_730,
    sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
};

pub const CATALOG: &[Model] = &[
    Model {
        id: "parakeet-tdt-0.6b-v3",
        name: "Parakeet TDT 0.6B v3",
        summary: "NVIDIA's multilingual dictation model: accurate and very fast on a computer. Can drift into English on German with many English words.",
        languages: "25 European languages, detected automatically",
        language_codes: &[
            "en", "de", "fr", "es", "it", "pt", "nl", "pl", "cs", "sk", "sl", "hr", "bg", "ro", "hu", "da", "sv", "fi", "et", "lv", "lt", "el", "uk", "ru", "mt",
        ],
        auto_language: true,
        kind: Kind::NemoTransducer,
        repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        commit: "2bda32ec70b097a55adaa07d9a7173915b43cc78",
        files: &[
            File { name: "encoder.int8.onnx", size: 652_184_281, sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247" },
            File { name: "decoder.int8.onnx", size: 11_845_275, sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e" },
            File { name: "joiner.int8.onnx", size: 6_355_277, sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3" },
            File { name: "tokens.txt", size: 93_939, sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d" },
        ],
        ram_mb: 1100,
        speed: 4,
        accuracy: 4,
        notes: "Fastest of the accurate ones: a sentence in 0.3–0.7 s on a desktop CPU. 2 % of words wrong in English and German dictation, 14 % in German full of English terms.",
        recommended: &[DeviceClass::Desktop],
    },
    Model {
        id: "canary-180m-flash",
        name: "Canary 180M Flash",
        summary: "NVIDIA's small model for four languages: accurate and light enough for a phone. Hears the language you set (or your device's).",
        languages: "English, German, French, Spanish",
        language_codes: &["en", "de", "fr", "es"],
        auto_language: false,
        kind: Kind::Canary,
        repo: "csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8",
        commit: "9077164e0d3dd1d5353743e89ceaa1d3a770838c",
        files: &[
            File { name: "encoder.int8.onnx", size: 132_678_643, sha256: "7a75b4e2a5857a6dcc0819503bbe3fad66943db4a3ccf21d3f27c633667d303f" },
            File { name: "decoder.int8.onnx", size: 74_437_848, sha256: "e41a2ab9c0c2fe81a1e8ade5a45fb02a74bc4db7d1f91b89a54a25e2cf79cba2" },
            File { name: "tokens.txt", size: 53_555, sha256: "2dae6fc7815f9640645e0c765522b278ee0cef49b482d91f6913e334628d3e77" },
        ],
        ram_mb: 450,
        speed: 4,
        accuracy: 4,
        notes: "A sentence in 0.5–1 s on a desktop CPU. 5 % of words wrong in English read speech, 7 % in German; drops more in German mixed with English terms.",
        recommended: &[DeviceClass::Phone],
    },
    Model {
        id: "whisper-turbo",
        name: "Whisper large-v3 turbo",
        summary: "OpenAI's most accurate fast Whisper: the best German here. Slower than Parakeet; for computers.",
        languages: "99 languages, detected automatically",
        language_codes: WHISPER_LANGS,
        auto_language: true,
        kind: Kind::Whisper { prefix: "turbo" },
        repo: "csukuangfj/sherpa-onnx-whisper-turbo",
        commit: "2ca6ff69fc878651b770880507669577ac41c2ff",
        files: &[
            File { name: "turbo-encoder.int8.onnx", size: 674_716_297, sha256: "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b" },
            File { name: "turbo-decoder.int8.onnx", size: 361_080_764, sha256: "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547" },
            File { name: "turbo-tokens.txt", ..WHISPER_TOKENS },
        ],
        ram_mb: 1800,
        speed: 2,
        accuracy: 5,
        notes: "The fewest mistakes in German read speech (4 %), but each utterance costs a full 30 s Whisper window: seconds per sentence on a CPU.",
        recommended: &[],
    },
    Model {
        id: "whisper-small",
        name: "Whisper small",
        summary: "A mid-sized Whisper for many languages.",
        languages: "99 languages, detected automatically",
        language_codes: WHISPER_LANGS,
        auto_language: true,
        kind: Kind::Whisper { prefix: "small" },
        repo: "csukuangfj/sherpa-onnx-whisper-small",
        commit: "8f3c18b358db4d1f2fc1eae49d75cd20989e4309",
        files: &[
            File { name: "small-encoder.int8.onnx", size: 112_442_483, sha256: "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9" },
            File { name: "small-decoder.int8.onnx", size: 262_226_114, sha256: "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee" },
            File { name: "small-tokens.txt", ..WHISPER_TOKENS },
        ],
        ram_mb: 700,
        speed: 2,
        accuracy: 3,
        notes: "A sentence in 4–5 s on a desktop CPU. 5 % of words wrong in English read speech, 10 % in German.",
        recommended: &[],
    },
    Model {
        id: "whisper-base",
        name: "Whisper base",
        summary: "A small Whisper for many languages: quick, but makes more mistakes.",
        languages: "99 languages, detected automatically",
        language_codes: WHISPER_LANGS,
        auto_language: true,
        kind: Kind::Whisper { prefix: "base" },
        repo: "csukuangfj/sherpa-onnx-whisper-base",
        commit: "bb53ee204431c90d314c1cc08d28d23e5b7927cc",
        files: &[
            File { name: "base-encoder.int8.onnx", size: 29_120_534, sha256: "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11" },
            File { name: "base-decoder.int8.onnx", size: 130_672_026, sha256: "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d" },
            File { name: "base-tokens.txt", ..WHISPER_TOKENS },
        ],
        ram_mb: 350,
        speed: 4,
        accuracy: 2,
        notes: "A sentence in 1–1.5 s on a desktop CPU. 7 % of words wrong in English read speech, 27 % in German.",
        recommended: &[],
    },
    Model {
        id: "moonshine-base-en",
        name: "Moonshine base (English)",
        summary: "Useful Sensors' English-only model: the fastest here, good for phones.",
        languages: "English",
        language_codes: &["en"],
        auto_language: true,
        kind: Kind::MoonshineV2,
        repo: "csukuangfj2/sherpa-onnx-moonshine-base-en-quantized-2026-02-27",
        commit: "8f4d6c58c03d40bcea40043bb7120a878f2bbef6",
        files: &[
            File { name: "encoder_model.ort", size: 31_326_816, sha256: "7c66495948d0d08ec1af454cd4b5514862ae6511e94712a60e6d83eaec8dc8cf" },
            File { name: "decoder_model_merged.ort", size: 109_424_400, sha256: "d9d7b333af34bc552580576ddcf248a1c6c839e0d3b43b09afb9376ed009899d" },
            File { name: "tokens.txt", size: 549_350, sha256: "2870d843e14c1e187bf1913a521562a63b53933814bd7f2145120468f494a049" },
        ],
        ram_mb: 300,
        speed: 5,
        accuracy: 3,
        notes: "A sentence in about 0.3 s on a desktop CPU; 8 % of words wrong in English read speech. English only.",
        recommended: &[],
    },
];

pub fn find(id: &str) -> Option<&'static Model> {
    CATALOG.iter().find(|m| m.id == id)
}

/// The model to suggest first on this kind of device.
pub fn recommended(device: DeviceClass) -> &'static Model {
    CATALOG.iter().find(|m| m.recommended_for(device)).unwrap_or(&CATALOG[0])
}

/// Every language some model knows, `auto` first, for Settings.
pub fn languages() -> Vec<(&'static str, &'static str)> {
    let mut out = vec![("auto", "Detect automatically")];
    for code in ["en", "de", "fr", "es", "it", "pt", "nl", "pl", "cs", "da", "sv", "fi", "uk", "ru", "tr", "ja", "zh", "ko"] {
        if CATALOG.iter().any(|m| m.language_codes.contains(&code)) {
            out.push((code, language_name(code)));
        }
    }
    out
}

pub fn language_name(code: &str) -> &'static str {
    match code {
        "en" => "English",
        "de" => "German",
        "fr" => "French",
        "es" => "Spanish",
        "it" => "Italian",
        "pt" => "Portuguese",
        "nl" => "Dutch",
        "pl" => "Polish",
        "cs" => "Czech",
        "da" => "Danish",
        "sv" => "Swedish",
        "fi" => "Finnish",
        "uk" => "Ukrainian",
        "ru" => "Russian",
        "tr" => "Turkish",
        "ja" => "Japanese",
        "zh" => "Chinese",
        "ko" => "Korean",
        _ => "Other",
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn every_model_is_pinned_and_complete() {
        let mut ids = HashSet::new();
        for m in CATALOG {
            assert!(ids.insert(m.id), "duplicate id {}", m.id);
            assert_eq!(m.commit.len(), 40, "{}: commit must be a full sha", m.id);
            assert!(m.commit.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(!m.language_codes.is_empty(), "{}", m.id);
            let names: HashSet<_> = m.files.iter().map(|f| f.name).collect();
            assert_eq!(names.len(), m.files.len(), "{}: duplicate file", m.id);
            for f in m.files {
                assert!(!f.name.is_empty() && !f.name.contains('/') && !f.name.contains(".."), "{}: {}", m.id, f.name);
                assert_eq!(f.sha256.len(), 64, "{}: {}", m.id, f.name);
                assert!(f.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
                assert!(f.size > 0);
            }
            // The files the engine opens for its kind are all downloaded.
            let needed: Vec<String> = match m.kind {
                Kind::NemoTransducer => ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"].map(String::from).to_vec(),
                Kind::Canary => ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"].map(String::from).to_vec(),
                Kind::Whisper { prefix } => ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"].map(|n| format!("{prefix}-{n}")).to_vec(),
                Kind::MoonshineV2 => ["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"].map(String::from).to_vec(),
            };
            for n in needed {
                assert!(names.contains(n.as_str()), "{}: missing {n}", m.id);
            }
            assert!(m.url(&m.files[0]).starts_with("https://huggingface.co/"));
            assert!(m.url(&m.files[0]).contains(m.commit));
        }
    }

    #[test]
    fn each_device_class_has_one_recommendation() {
        for d in [DeviceClass::Desktop, DeviceClass::Phone] {
            assert_eq!(CATALOG.iter().filter(|m| m.recommended_for(d)).count(), 1, "{d:?}");
        }
        // Light on phones: the phone pick is smaller than the desktop pick.
        assert!(recommended(DeviceClass::Phone).size() < recommended(DeviceClass::Desktop).size());
    }

    #[test]
    fn language_choice_follows_the_model() {
        let canary = find("canary-180m-flash").unwrap();
        assert_eq!(canary.language_for("de", None), Some("de"));
        // Auto on a model that needs a language: the device's, else its first.
        assert_eq!(canary.language_for("auto", Some("de-AT")), Some("de"));
        assert_eq!(canary.language_for("auto", Some("ja-JP")), Some("en"));
        assert_eq!(canary.language_for("auto", None), Some("en"));
        // A language it doesn't know: its fallback.
        assert_eq!(canary.language_for("ja", None), Some("en"));
        let whisper = find("whisper-turbo").unwrap();
        assert_eq!(whisper.language_for("auto", Some("de-DE")), None);
        assert_eq!(whisper.language_for("de", None), Some("de"));
        // A language Whisper doesn't list: it detects instead.
        assert_eq!(whisper.language_for("xx", None), None);
    }

    #[test]
    fn languages_start_with_auto_and_are_known_names() {
        let langs = languages();
        assert_eq!(langs[0].0, "auto");
        assert!(langs.iter().skip(1).all(|(_, n)| *n != "Other"));
        assert!(langs.iter().any(|(c, _)| *c == "de"));
    }
}
