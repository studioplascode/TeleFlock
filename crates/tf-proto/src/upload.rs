//! Chunked file uploads to the host (`upload.*`). Videos attached to a prompt travel this way:
//! they are far larger than one request may carry (images stay inline as
//! [`crate::methods::ImageInput`]), and the agent reads the file from the host path with its own
//! tools.
//!
//! `upload.begin` reserves a file under `<hostd home>/uploads/<yyyy-mm-dd>/`, `upload.chunk`
//! appends base64 chunks strictly in order (each `offset` must equal the bytes received so far;
//! out-of-order, repeated and overflowing chunks are refused), `upload.status` says where an upload
//! stands (to resume after a lost response or a reconnect), `upload.finish` moves the complete file
//! into place, and `upload.cancel` drops it.

wire_struct! {
    pub struct UploadBeginParams {
        /// The file's name on the client. The host keeps a sanitized form of it, extension included.
        pub name: String,
        /// Exact size in bytes: 1 B to 2 GiB.
        pub size: u64,
        /// MIME type (`video/mp4`): supplies the extension when the name has none.
        pub mime: Option<String>,
    }
}

wire_struct! {
    pub struct UploadBegun {
        pub upload_id: String,
        /// Absolute path on the host the file gets once finished.
        pub path: String,
        /// Largest chunk the host takes, in raw bytes (before base64).
        pub max_chunk: u32,
    }
}

wire_struct! {
    pub struct UploadChunkParams {
        pub upload_id: String,
        /// Where this chunk starts: the number of bytes received so far.
        pub offset: u64,
        /// Base64 payload (at most `UploadBegun.maxChunk` bytes once decoded).
        pub data: String,
    }
}

wire_struct! { pub struct UploadRef { pub upload_id: String } }

wire_struct! {
    pub struct UploadProgress {
        pub upload_id: String,
        /// Bytes received so far: the next chunk's `offset` (equal to `size` once finished).
        pub received: u64,
        pub size: u64,
    }
}

wire_struct! {
    pub struct UploadFinishParams {
        pub upload_id: String,
        /// Hex SHA-256 of the whole file; checked when given.
        pub sha256: Option<String>,
    }
}

wire_struct! {
    pub struct UploadFinished {
        /// Absolute path on the host.
        pub path: String,
        pub size: u64,
        /// Hex SHA-256 of what the host received.
        pub sha256: String,
    }
}

#[cfg(test)]
mod tests {
    use crate::HostMethod;

    #[test]
    fn chunk_params_are_camel_case() {
        let req = HostMethod::parse("upload.chunk", serde_json::json!({ "uploadId": "up_1", "offset": 1048576, "data": "AAAA" })).unwrap();
        let HostMethod::UploadChunk(p) = req else { panic!("wrong variant") };
        assert_eq!((p.upload_id.as_str(), p.offset, p.data.as_str()), ("up_1", 1 << 20, "AAAA"));
        // A finish without a checksum is fine; a begin without a size is not.
        assert!(HostMethod::parse("upload.finish", serde_json::json!({ "uploadId": "up_1" })).is_ok());
        assert_eq!(HostMethod::parse("upload.begin", serde_json::json!({ "name": "a.mp4" })).unwrap_err().code, "invalid_params");
    }
}
