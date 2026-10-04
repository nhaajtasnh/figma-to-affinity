# Figma → Affinity (bản beta 0.2.0)

Chuyển thiết kế Figma thành file Affinity **chỉnh sửa được**: artboard, chữ, shape, đường cong, ảnh, mask, gradient, bóng đổ và guide đều là object gốc của Affinity, không phải ảnh dán vào.

Bộ công cụ gồm 2 phần:

- `figma-plugin/`: plugin Figma, xuất frame đang chọn ra file `.figaf`.
- `affinity-script/figaf-import.js`: script cho **Affinity 3.3 trở lên**, đọc file `.figaf` và dựng lại thành document Affinity.

> Đây là bản beta. Hãy so kết quả với Figma trước khi giao file cho khách, và gửi lỗi theo hướng dẫn ở cuối trang.

## 1. Cài đặt (làm một lần)

### Plugin Figma

1. Giải nén gói, giữ nguyên 3 file `manifest.json`, `code.js`, `ui.html` trong thư mục `figma-plugin`.
2. Mở **Figma desktop app**. Plugin cài từ file chỉ chạy trên bản desktop, không chạy trên trình duyệt.
3. Mở một file thiết kế bất kỳ, vào **Plugins → Development → Import plugin from manifest…** rồi chọn `manifest.json`.
4. Plugin sẽ có trong **Plugins → Development → Figma to Affinity (beta)**.

### Script Affinity

1. Mở Affinity, chuyển sang **Scripting Studio**.
2. Tạo script mới, dán toàn bộ nội dung `figaf-import.js` vào rồi lưu vào thư viện script.
3. Cấp quyền đọc file. Thiếu một trong hai bước này, script sẽ báo `PERMISSION_DENIED`:
   - **Settings → Scripting → File System access**: thêm thư mục bạn sẽ đặt file `.figaf` vào (ví dụ Desktop). Danh sách này mặc định trống.
   - Trong Scripting Studio, bấm **biểu tượng bánh răng** của script và bật quyền **File System**.

## 2. Sử dụng

1. Trong Figma, chọn một hoặc nhiều frame. Mỗi frame sẽ thành một artboard.
2. Chạy plugin, bấm **Xuất frame đang chọn**. Chép file `.figaf` vừa tải về vào thư mục đã cấp quyền ở bước cài đặt.
3. Trong Affinity, chạy script và chọn file `.figaf`. Script tạo một document mới.
4. Kiểm tra kết quả, rồi lưu bằng **File → Save As** ra file `.af`.

Script ghi một file báo cáo `… - bao cao chuyen doi.txt` ra Desktop. Báo cáo liệt kê font máy chưa cài, layer bị lỗi, và những gì bị bỏ qua hoặc giản lược, kèm tên layer để bạn sửa tay.

## 3. Những gì được chuyển

| Trong Figma | Sang Affinity |
|---|---|
| Frame cấp cao nhất | Artboard (có nền) |
| Frame lồng bên trong | Shape cắt nội dung (khi bật Clip content), hoặc nhóm kèm nền |
| Group | Nhóm |
| Rectangle, ellipse | Shape gốc, giữ bo góc từng góc (chỉnh được độ bo) |
| Vector, star, polygon, boolean | Đường cong, sửa được từng điểm |
| Text | Chữ chỉnh sửa được: font, cỡ, màu, giãn chữ, line height, khoảng cách đoạn, canh lề, nhiều style trong một khối. Chữ một dòng tự co giãn thành Artistic Text, còn lại thành Frame Text cùng chiều rộng |
| Ảnh (fill / fit / crop) | Ảnh gốc (tối đa 4096px cạnh dài), đặt nguyên tấm trong khung, cắt lại được |
| Mask | Mask layer của Affinity |
| Nhiều lớp màu trên một shape | Nhóm gồm nhiều shape chồng lên nhau, mỗi shape một lớp màu |
| Gradient tuyến tính / tròn / góc | Gradient tuyến tính / tròn / Conical |
| Drop shadow, inner shadow, layer blur | Layer effect. Bóng đổ thứ hai trở đi và bóng không blur được dựng bằng bản sao shape nằm dưới, tên có chữ "bóng" |
| Viền | Viền, giữ độ dày, vị trí (trong/giữa/ngoài), đầu nét và góc nối |
| Layout grid dạng cột/hàng, guide | Guide |

## 4. Giới hạn đã biết

- **Auto layout** thành vị trí cố định. Component, variant, instance thành nhóm thường. Variables và prototype không được chuyển.
- **Không chuyển được** (báo cáo sẽ ghi tên layer): background blur, blend mode, lưới ô vuông, gạch chân chữ, inner shadow thứ hai trở đi trên cùng một layer.
- **Giản lược:** viền nét đứt thành viền liền. Corner smoothing (bo góc kiểu iOS) thành bo góc tròn thường. Chữ UPPER/lower được đổi hẳn thành chữ in hoa/thường. Mask độ sáng thành mask theo hình dạng.
- **Font:** máy mở file phải cài đúng font dùng trong Figma. Chữ Hán/Nhật/Hàn đặt bằng font không có các ký tự đó (ví dụ Inter) sẽ hiển thị khác nhau giữa hai phần mềm. Hãy chọn font CJK, hoặc outline nếu là logo.
- Chữ có thể lệch 1–2px theo chiều dọc do hai phần mềm tính line height khác nhau.
- Hai hình có mép trùng khít nhau có thể lộ một vệt mảnh dưới 1px khi zoom lớn. Thường không thấy khi export ở kích thước thật. Muốn sạch hẳn thì phóng to hình phía dưới thêm khoảng 1px.

## 5. Tuỳ chỉnh

Các tuỳ chọn nằm ở đầu file `figaf-import.js`:

| Tuỳ chọn | Mặc định | Ý nghĩa |
|---|---|---|
| `ROUND_TO_PIXEL` | `true` | Làm tròn vị trí và kích thước về số nguyên pixel. Hình xê dịch tối đa 0,5px so với Figma |
| `MASK_AS_LAYER` | `true` | Dựng mask thành mask layer. Đặt `false` để dùng cách clip vào shape |
| `ADD_GUIDES` | `true` | Chuyển layout grid và guide thành guide |
| `SHADOW_BLUR_SCALE` | `1.0` | Hệ số độ mờ bóng đổ |
| `DEBUG` | `false` | In chi tiết từng layer ra console, dùng khi báo lỗi |

## 6. Báo lỗi

Khi kết quả khác Figma, vui lòng gửi:

1. **Ảnh chụp so sánh** Figma và Affinity ở cùng vùng bị lỗi.
2. **File báo cáo** `… - bao cao chuyen doi.txt` trên Desktop. Dòng đầu tiên ghi phiên bản plugin và script.
3. **Log chi tiết:** mở script, đổi `DEBUG = false` thành `true`, chạy lại, rồi copy toàn bộ nội dung trong console của Scripting Studio.
4. Nếu được, gửi kèm file `.figaf` hoặc file Figma (chỉ phần bị lỗi).

## Giấy phép

MIT, xem file [LICENSE](LICENSE).
