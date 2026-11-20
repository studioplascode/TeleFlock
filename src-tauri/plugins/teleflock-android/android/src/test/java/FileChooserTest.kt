package dev.teleflock.android

import org.junit.Assert.assertEquals
import org.junit.Test

class FileChooserTest {
    private val byExtension = mapOf("pdf" to "application/pdf", "md" to "text/markdown", "jpg" to "image/jpeg")::get

    @Test
    fun asksForTheWholeAcceptList() {
        assertEquals(
            listOf("image/*", "application/pdf", "text/markdown"),
            FileChooser.mimeTypes(arrayOf("image/*", ".PDF", " .md ", "application/pdf"), byExtension),
        )
        assertEquals(listOf("image/*", "video/*"), FileChooser.mimeTypes(arrayOf("image/*", "video/*"), byExtension))
        assertEquals(listOf("image/jpeg"), FileChooser.mimeTypes(arrayOf(".jpg", "IMAGE/JPEG"), byExtension))
    }

    @Test
    fun anyFileWhenTheListNamesNothingOrSomethingNoTypeNames() {
        // An upload field without `accept` reaches the chooser as one empty entry.
        assertEquals(emptyList<String>(), FileChooser.mimeTypes(arrayOf(""), byExtension))
        assertEquals(emptyList<String>(), FileChooser.mimeTypes(emptyArray(), byExtension))
        // `.sketch` has no MIME type: asking for PDFs alone would hide the sketches the page takes.
        assertEquals(emptyList<String>(), FileChooser.mimeTypes(arrayOf(".pdf", ".sketch"), byExtension))
        assertEquals(emptyList<String>(), FileChooser.mimeTypes(arrayOf("image", "/x", "text/"), byExtension))
    }
}
