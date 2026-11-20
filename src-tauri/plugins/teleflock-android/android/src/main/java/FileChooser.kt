package dev.teleflock.android

/**
 * What an upload field asks the system picker for ([PreviewActivity]): its `accept` list as MIME
 * types for `Intent.EXTRA_MIME_TYPES`, under the any-file type. A list that names a document then
 * opens the document picker: Android's photo picker keeps a GET_CONTENT request only while every
 * type asked for is an image or video type, and hands any other to the document picker.
 */
internal object FileChooser {
    /**
     * `accept` (`FileChooserParams.acceptTypes`: MIME types, wildcards included, and `.ext`
     * entries) as MIME types, extensions looked up with `byExtension`. Empty means any file: an
     * empty list, or one with an entry no MIME type names, since leaving that entry out would make
     * the files the page asked for unpickable.
     */
    fun mimeTypes(accept: Array<String>, byExtension: (String) -> String?): List<String> {
        val types = LinkedHashSet<String>()
        for (raw in accept) {
            val entry = raw.trim().lowercase()
            if (entry.isEmpty()) continue
            val type = when {
                entry.startsWith(".") -> byExtension(entry.substring(1))
                entry.indexOf('/') in 1 until entry.length - 1 -> entry
                else -> null
            } ?: return emptyList()
            types.add(type)
        }
        return types.toList()
    }
}
