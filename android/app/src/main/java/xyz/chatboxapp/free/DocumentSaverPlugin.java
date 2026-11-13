package xyz.chatboxapp.free;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "DocumentSaver")
public class DocumentSaverPlugin extends Plugin {
    @PluginMethod
    public void saveFile(PluginCall call) {
        String sourceUri = call.getString("sourceUri");
        String suggestedName = call.getString("suggestedName", "export");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        if (sourceUri == null || sourceUri.trim().isEmpty()) {
            call.reject("sourceUri is required");
            return;
        }
        call.setKeepAlive(true);
        getBridge().saveCall(call);
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, suggestedName);
        intent.putExtra("sourceUri", sourceUri);
        startActivityForResult(call, intent, "saveFileResult");
    }

    @ActivityCallback
    private void saveFileResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) {
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.setKeepAlive(false);
            call.reject("SAVE_CANCELED", "SAVE_CANCELED");
            return;
        }
        Uri destination = result.getData().getData();
        String sourceUri = call.getString("sourceUri");
        try {
            if (sourceUri == null || sourceUri.trim().isEmpty()) {
                call.reject("sourceUri is required");
                return;
            }
            copyStream(sourceUri, destination);
            JSObject saved = new JSObject();
            saved.put("uri", destination.toString());
            call.resolve(saved);
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "Failed to save file" : error.getMessage(), error);
        } finally {
            call.setKeepAlive(false);
        }
    }

    private InputStream openSource(String sourceUri) throws Exception {
        if (sourceUri.startsWith("content:")) {
            InputStream input = getContext().getContentResolver().openInputStream(Uri.parse(sourceUri));
            if (input == null) {
                throw new IllegalStateException("Unable to open the selected file");
            }
            return input;
        }
        String path = sourceUri.startsWith("file:") ? Uri.parse(sourceUri).getPath() : sourceUri;
        if (path == null || path.isEmpty()) {
            throw new IllegalStateException("Unable to open the selected file");
        }
        return new FileInputStream(new File(path));
    }

    private void copyStream(String sourceUri, Uri destination) throws Exception {
        try (
            InputStream input = openSource(sourceUri);
            OutputStream output = getContext().getContentResolver().openOutputStream(destination)
        ) {
            if (input == null || output == null) {
                throw new IllegalStateException("Unable to open the selected file");
            }
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            output.flush();
        }
    }
}
