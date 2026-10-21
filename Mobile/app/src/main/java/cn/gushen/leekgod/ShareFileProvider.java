package cn.gushen.leekgod;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 分享图片用的最小 ContentProvider（纯 framework，不引 androidx FileProvider）。
 *
 * 只读暴露 cacheDir/share/ 下由 MainActivity.shareImage() 写入的文件，
 * 以 content://cn.gushen.leekgod.share/<文件名> 的形式给系统分享面板，
 * 接收方（微信等）靠 grantUriPermissions 拿临时读权限。
 * 文件名在 Bridge 侧已做过白名单过滤，这里再兜一层：拒绝路径分隔符与 ..。
 */
public class ShareFileProvider extends ContentProvider {

    private File shareDir() {
        return new File(getContext().getCacheDir(), "share");
    }

    private File resolve(String name) {
        if (name == null || name.contains("/") || name.contains("\\") || name.contains("..")) {
            return null;
        }
        File f = new File(shareDir(), name);
        try {
            String canonDir = shareDir().getCanonicalPath();
            if (!f.getCanonicalPath().startsWith(canonDir + File.separator)) return null;
        } catch (Exception e) {
            return null;
        }
        return f;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = resolve(uri.getLastPathSegment());
        if (f == null || !f.isFile()) throw new FileNotFoundException(uri.toString());
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    /** 微信等接收方会 query 显示名/大小，给个最小实现（不给就当 null 处理，部分 App 会挑剔） */
    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        File f = resolve(uri.getLastPathSegment());
        if (f == null || !f.isFile()) return null;
        String[] cols = projection == null
                ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}
                : projection;
        MatrixCursor cursor = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
            else row[i] = null;
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return "image/png";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
