# JNI entry points, the service, the receiver and the plugin are referenced by name
# (manifest, Class.forName from Rust, JNI symbol lookup).
-keep class dev.teleflock.android.** { *; }
