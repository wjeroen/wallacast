package io.github.wjeroen.wallacast.watch;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.os.SystemClock;
import android.view.View;

/**
 * One line of text that scrolls when it is too long, as an iPod shows a title: it waits at the
 * start, scrolls to the end, waits, jumps back to the start and begins again. Text that fits
 * stands still in the middle. While it scrolls, the edge the text runs past fades out.
 */
public class TickerText extends View {
    private static final long WAIT_START_MS = 2500;
    private static final long WAIT_END_MS = 1200;
    private static final float SPEED_DP_PER_SECOND = 30;
    private static final float FADE_DP = 10;

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final float density;
    private String text = "";
    private float textWidth;
    private long cycleStart = SystemClock.uptimeMillis();
    private boolean running = true;

    public TickerText(Context context) {
        super(context);
        density = context.getResources().getDisplayMetrics().density;
        paint.setTextAlign(Paint.Align.LEFT);
    }

    public void setTextSizePx(float px) {
        paint.setTextSize(px);
        textWidth = paint.measureText(text);
        requestLayout();
    }

    public void setColor(int color) {
        paint.setColor(color);
        invalidate();
    }

    public void setBold(boolean bold) {
        paint.setTypeface(Typeface.create(Typeface.DEFAULT, bold ? Typeface.BOLD : Typeface.NORMAL));
        textWidth = paint.measureText(text);
    }

    public void setText(String value) {
        String t = value == null ? "" : value;
        if (t.equals(text)) return;
        text = t;
        textWidth = paint.measureText(t);
        cycleStart = SystemClock.uptimeMillis();
        invalidate();
    }

    /** Scrolls only while running: the screen calls this when it shows and hides. */
    public void setRunning(boolean run) {
        if (run && !running) cycleStart = SystemClock.uptimeMillis();
        running = run;
        invalidate();
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        Paint.FontMetrics fm = paint.getFontMetrics();
        int h = (int) Math.ceil(fm.descent - fm.ascent);
        setMeasuredDimension(MeasureSpec.getSize(widthSpec), resolveSize(h, heightSpec));
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float w = getWidth(), h = getHeight();
        Paint.FontMetrics fm = paint.getFontMetrics();
        float baseline = (h - (fm.descent - fm.ascent)) / 2f - fm.ascent;
        paint.setShader(null);
        if (textWidth <= w) {
            canvas.drawText(text, (w - textWidth) / 2f, baseline, paint);
            return;
        }
        float overflow = textWidth - w;
        long scrollMs = (long) (overflow / (SPEED_DP_PER_SECOND * density) * 1000f);
        long cycle = WAIT_START_MS + scrollMs + WAIT_END_MS;
        long t = running ? (SystemClock.uptimeMillis() - cycleStart) % cycle : 0;
        float offset;
        long redrawIn;
        if (t < WAIT_START_MS) {
            offset = 0;
            redrawIn = WAIT_START_MS - t;
        } else if (t < WAIT_START_MS + scrollMs) {
            offset = (t - WAIT_START_MS) / (float) scrollMs * overflow;
            redrawIn = 0;
        } else {
            offset = overflow;
            redrawIn = cycle - t;
        }

        // Fade the edge the text runs past: the left one once it moved, the right one until its end shows
        float fade = FADE_DP * density;
        int color = paint.getColor();
        int clear = color & 0x00FFFFFF;
        boolean left = offset > 0.5f, right = offset < overflow - 0.5f;
        if (left || right) {
            float[] stops = {0f, fade / w, 1f - fade / w, 1f};
            int[] colors = {left ? clear : color, color, color, right ? clear : color};
            paint.setShader(new LinearGradient(0, 0, w, 0, colors, stops, Shader.TileMode.CLAMP));
        }
        canvas.save();
        canvas.clipRect(0, 0, w, h);
        canvas.drawText(text, -offset, baseline, paint);
        canvas.restore();
        paint.setShader(null);

        if (!running) return;
        if (redrawIn == 0) postInvalidateOnAnimation();
        else postInvalidateDelayed(redrawIn);
    }
}
