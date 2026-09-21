# Telegram File Renamer Bot

یک ربات GramJS برای دریافت فایل، تغییر نام و ارسال مجدد آن با SQLite، صف پردازش، لغو پردازش، دسته‌بندی، رفرال و پریمیوم.

## پیش‌نیاز

- Node.js 20 یا جدیدتر
- `TELEGRAM_API_ID` و `TELEGRAM_API_HASH` از my.telegram.org
- توکن ربات از BotFather
- شناسه عددی ادمین

## اجرا

```bash
cp .env.example .env
# مقدارهای .env را پر کن
npm install
npm run dev
```

برای اجرای production:

```bash
npm run build
npm start
```

جلسهٔ GramJS و دیتابیس در `DATA_DIR` ذخیره می‌شوند. فایل `.env` و پوشهٔ `data` را commit نکن.

## دستورات ادمین

```text
/ping
/stats
/pending
/approve USER_ID
/reject USER_ID
/ban USER_ID
/unban USER_ID
/banlist
/premium USER_ID DAYS GB
/setlimit GB
/broadcast TEXT
/cleanup
```

## نکتهٔ مهم GramJS

این پروژه عمداً از GramJS استفاده می‌کند، نه Bot API معمولی؛ چون محدودیت حجم Bot API برای ایدهٔ تغییرنام فایل مناسب نیست. دکمه‌ها با `Api.InlineKeyboardButton` ساخته شده‌اند و ارسال آپلود به شکل `uploadFile` سپس `sendFile` انجام می‌شود تا callback و progress قابل‌کنترل‌تر باشند.

قبل از production این موارد را روی یک bot آزمایشی تست کن:

1. فایل معمولی، ویدیو، صوت و فایل بدون نام.
2. لغو هنگام دانلود و هنگام آپلود.
3. قطع شبکه و retry.
4. چند کاربر هم‌زمان.
5. مقدارهای FloodWait تلگرام.
