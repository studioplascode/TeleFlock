//! Order-preserving JSON for omp's MCP config files.
//!
//! omp reads them with `JSON.parse` and writes them with `JSON.stringify(config, null, 2)`
//! (`mcp/config-writer.ts`): keys keep their order, new keys are appended, there is no trailing
//! newline. The workspace's `serde_json` sorts object keys (no `preserve_order`), so edits go
//! through this small value type instead: a parsed file written back unchanged is byte-identical
//! to what omp writes, and every field TeleFlock doesn't know survives an edit in place.

use std::fmt;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};

/// A JSON value whose objects keep their key order.
#[derive(Debug, Clone, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    Num(serde_json::Number),
    Str(String),
    Arr(Vec<J>),
    Obj(Obj),
}

/// A JSON object in file order. A repeated key keeps its first position and its last value
/// (`JSON.parse` semantics).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Obj(pub Vec<(String, J)>);

impl Obj {
    pub fn get(&self, key: &str) -> Option<&J> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut J> {
        self.0.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// Replaces the value in place, else appends.
    pub fn set(&mut self, key: &str, value: J) {
        match self.get_mut(key) {
            Some(v) => *v = value,
            None => self.0.push((key.to_string(), value)),
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<J> {
        let i = self.0.iter().position(|(k, _)| k == key)?;
        Some(self.0.remove(i).1)
    }

    /// Renames `from` to `to` in place (same position); an existing `to` is dropped. `false` when
    /// `from` is absent.
    pub fn rename(&mut self, from: &str, to: &str) -> bool {
        if from == to {
            return self.contains(from);
        }
        if !self.contains(from) {
            return false;
        }
        self.remove(to);
        let i = self.0.iter().position(|(k, _)| k == from).expect("present: checked above");
        self.0[i].0 = to.to_string();
        true
    }

    pub fn insert_first(&mut self, key: &str, value: J) {
        self.remove(key);
        self.0.insert(0, (key.to_string(), value));
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(|(k, _)| k.as_str())
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(J::as_str)
    }

    pub fn obj(&self, key: &str) -> Option<&Obj> {
        self.get(key).and_then(J::as_obj)
    }

    pub fn obj_mut(&mut self, key: &str) -> Option<&mut Obj> {
        match self.get_mut(key) {
            Some(J::Obj(o)) => Some(o),
            _ => None,
        }
    }
}

impl J {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            J::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_obj(&self) -> Option<&Obj> {
        match self {
            J::Obj(o) => Some(o),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&[J]> {
        match self {
            J::Arr(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            J::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// A non-negative integer (JSON numbers are doubles in omp: `30000.0` counts).
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            J::Num(n) => n.as_u64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0 && *f >= 0.0 && *f <= 9.007_199_254_740_992e15).map(|f| f as u64)),
            _ => None,
        }
    }

    pub fn str(s: impl Into<String>) -> J {
        J::Str(s.into())
    }

    pub fn num(n: u64) -> J {
        J::Num(n.into())
    }

    pub fn strings(items: &[String]) -> J {
        J::Arr(items.iter().map(|s| J::Str(s.clone())).collect())
    }

    /// From a `serde_json::Value` (helper answers). Object keys come in that value's order.
    pub fn from_value(v: &serde_json::Value) -> J {
        match v {
            serde_json::Value::Null => J::Null,
            serde_json::Value::Bool(b) => J::Bool(*b),
            serde_json::Value::Number(n) => J::Num(n.clone()),
            serde_json::Value::String(s) => J::Str(s.clone()),
            serde_json::Value::Array(a) => J::Arr(a.iter().map(J::from_value).collect()),
            serde_json::Value::Object(o) => J::Obj(Obj(o.iter().map(|(k, v)| (k.clone(), J::from_value(v))).collect())),
        }
    }

    /// To a `serde_json::Value` (key order is lost: for transport to the helper only).
    pub fn to_value(&self) -> serde_json::Value {
        match self {
            J::Null => serde_json::Value::Null,
            J::Bool(b) => serde_json::Value::Bool(*b),
            J::Num(n) => serde_json::Value::Number(n.clone()),
            J::Str(s) => serde_json::Value::String(s.clone()),
            J::Arr(a) => serde_json::Value::Array(a.iter().map(J::to_value).collect()),
            J::Obj(o) => serde_json::Value::Object(o.0.iter().map(|(k, v)| (k.clone(), v.to_value())).collect()),
        }
    }
}

/// Parses a whole document (`JSON.parse`: surrounding whitespace allowed, nothing else).
pub fn parse(text: &str) -> Result<J, String> {
    // A UTF-8 BOM is not JSON; JSON.parse on file text read as utf-8 rejects it too.
    serde_json::from_str::<J>(text).map_err(|e| e.to_string())
}

/// `JSON.stringify(v, null, 2)`.
pub fn pretty(v: &J) -> String {
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(b"  "));
    v.serialize(&mut ser).expect("serializing to a Vec cannot fail");
    String::from_utf8(out).expect("serde_json writes UTF-8")
}

/// `JSON.stringify(v)`.
pub fn compact(v: &J) -> String {
    serde_json::to_string(v).expect("serializing to a String cannot fail")
}

impl Serialize for J {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            J::Null => s.serialize_unit(),
            J::Bool(b) => s.serialize_bool(*b),
            J::Num(n) => {
                if let Some(i) = n.as_i64() {
                    s.serialize_i64(i)
                } else if let Some(u) = n.as_u64() {
                    s.serialize_u64(u)
                } else {
                    // JS prints integral doubles without a fraction (`30000`, not `30000.0`).
                    let f = n.as_f64().unwrap_or(0.0);
                    if f.fract() == 0.0 && f.abs() < 1e21 {
                        if f < 0.0 { s.serialize_i64(f as i64) } else { s.serialize_u64(f as u64) }
                    } else {
                        s.serialize_f64(f)
                    }
                }
            }
            J::Str(v) => s.serialize_str(v),
            J::Arr(a) => {
                let mut seq = s.serialize_seq(Some(a.len()))?;
                for v in a {
                    seq.serialize_element(v)?;
                }
                seq.end()
            }
            J::Obj(o) => {
                let mut map = s.serialize_map(Some(o.0.len()))?;
                for (k, v) in &o.0 {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for J {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<J, D::Error> {
        d.deserialize_any(JVisitor)
    }
}

struct JVisitor;

impl<'de> Visitor<'de> for JVisitor {
    type Value = J;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_unit<E: de::Error>(self) -> Result<J, E> {
        Ok(J::Null)
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<J, E> {
        Ok(J::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<J, E> {
        Ok(J::Num(v.into()))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<J, E> {
        Ok(J::Num(v.into()))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<J, E> {
        serde_json::Number::from_f64(v).map(J::Num).ok_or_else(|| E::custom("non-finite number"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<J, E> {
        Ok(J::Str(v.to_string()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<J, E> {
        Ok(J::Str(v))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<J, A::Error> {
        let mut out = Vec::new();
        while let Some(v) = seq.next_element::<J>()? {
            out.push(v);
        }
        Ok(J::Arr(out))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<J, A::Error> {
        let mut obj = Obj::default();
        while let Some((k, v)) = map.next_entry::<String, J>()? {
            obj.set(&k, v);
        }
        Ok(J::Obj(obj))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What omp's writer produced for a real config (`JSON.stringify(withSchema(config), null, 2)`).
    const OMP_WRITTEN: &str = r#"{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "zeta": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/tmp/a b"
      ],
      "env": {},
      "timeout": 30000,
      "requestIdFormat": "string"
    },
    "alpha": {
      "type": "http",
      "url": "https://mcp.example.com/mcp?x=1&y=\"q\"",
      "headers": {
        "Authorization": "Bearer ${TOKEN}"
      },
      "enabled": false,
      "x-unknown": [
        1.5,
        null,
        true,
        "ü\u0001\n"
      ]
    }
  },
  "disabledServers": [
    "gamma"
  ]
}"#;

    #[test]
    fn round_trip_is_byte_identical_and_keeps_key_order() {
        let v = parse(OMP_WRITTEN).unwrap();
        assert_eq!(pretty(&v), OMP_WRITTEN);
        let servers = v.as_obj().unwrap().obj("mcpServers").unwrap();
        assert_eq!(servers.keys().collect::<Vec<_>>(), ["zeta", "alpha"], "file order, not sorted");
    }

    #[test]
    fn edits_keep_positions_and_append_new_keys() {
        let J::Obj(mut root) = parse(r#"{"b":1,"a":{"x":true}}"#).unwrap() else { panic!() };
        root.set("b", J::num(2));
        root.set("c", J::str("new"));
        assert!(root.rename("a", "z"));
        assert_eq!(compact(&J::Obj(root.clone())), r#"{"b":2,"z":{"x":true},"c":"new"}"#);
        root.insert_first("$schema", J::str("s"));
        assert_eq!(root.keys().next(), Some("$schema"));
        assert!(!root.rename("missing", "q"));
    }

    #[test]
    fn duplicate_keys_keep_first_position_and_last_value() {
        let v = parse(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(compact(&v), r#"{"a":3,"b":2}"#);
    }

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(compact(&parse("[30000.0, -2.0, 0.25, 1e3]").unwrap()), "[30000,-2,0.25,1000]");
        assert_eq!(parse("30000.0").unwrap().as_u64(), Some(30000));
        assert_eq!(parse("-1").unwrap().as_u64(), None);
    }

    #[test]
    fn invalid_documents_are_refused() {
        assert!(parse("{\"a\": 1,}").is_err(), "trailing comma");
        assert!(parse("// comment\n{}").is_err(), "omp's JSON.parse rejects comments");
        assert!(parse("{} {}").is_err());
        assert!(parse("").is_err());
        assert!(parse("  {}\n").is_ok());
    }

    #[test]
    fn empty_containers_print_inline() {
        assert_eq!(pretty(&parse(r#"{"a":{},"b":[]}"#).unwrap()), "{\n  \"a\": {},\n  \"b\": []\n}");
    }
}
