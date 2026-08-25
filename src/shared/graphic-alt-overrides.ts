import path from "node:path";

// OCR is intentionally not trusted for these diagrams. Each description was
// checked against the downloaded source image and is keyed by its SHA-256 file
// name so the result stays stable when database IDs or export ordering change.
const GRAPHIC_ALT_OVERRIDES: Readonly<Record<string, string>> = {
  "9cde6ddebab0ed5277cbd929773f4e9c755abcd64b54dae2f694e71490b3ebc2":
    "Sơ đồ khu nghỉ dưỡng: phòng 101 ở bên trái; phòng 102 và 103 ở phía trên; phòng 104 ở góc trên bên phải; văn phòng ở góc dưới trái, hồ bơi ở góc dưới phải và bãi đỗ xe ở giữa.",
  "85c24862f644774c17534cd093eb6584c99cfecd01771199f9933aa1c6d2bb86":
    "Bảng màu và giá: Garden Green 23 đô-la, Misty Blue 27 đô-la, Sunrise Peach 19 đô-la và Antique White 16 đô-la.",
  "725d3c1b7c96717f2c15cd54844842a4b888c3304439acf8d396c57242bde112":
    "Quầy trưng bày bốn bánh: Richard ở góc trên trái, Alison ở góc trên phải, Tomas ở góc dưới trái với số 25 và Janet ở góc dưới phải.",
  dee3af8ffbb8ba8916d4b9fe049ada8ba0454f241b7ef376fb98de1fac8dcd19:
    "Sơ đồ phòng tiệc: sân khấu ở phía trên, cửa ở bên trái; bàn 1 bên trái, bàn 2 ở giữa phía trên, bàn 3 bên phải và bàn 4 ở giữa phía dưới.",
  "9e15100e556ef45d8352773fc17f32616fb67e93bdc6c8746481316b9e0676e5":
    "Sơ đồ hội trường: sân khấu ở phía trên; lối thoát ở hai bên và giữa phía dưới; vị trí 1 góc trên trái, 2 góc trên phải, 3 dưới quầy vé và 4 dưới quán cà phê.",
  b7a7a9473dc0c36b37998fd69b62e2d5df2a8c6dcbda6fe2959fb0239b7d48d9:
    "Kệ hàng lưu niệm: áo thun 35 đô-la, túi 18 đô-la, mũ 25 đô-la và bình nước 12 đô-la.",
  "9c94b0383c3754b7d19fb97a18aba4f2cff936340e9f39f8f374113376309e47":
    "Bốn mẫu logo được đánh số: 1 là núi, đảo và mặt trời; 2 là quả dứa đeo kính cạnh ô; 3 là mặt trời trên ván lướt sóng; 4 là cây cọ trong các vòng tròn.",
  b7f5d32171cd57692a80b5071790ae2c636bc56d62c8279b3aac0417fd597c5a:
    "Bảng hàm lượng theo địa điểm: Site 1 là 150 gram mỗi tấn, Site 2 là 270, Site 3 là 390 và Site 4 là 410.",
  "791b09182c6e56472d17fd1ac76cfa6596eabf7ead083a696e533ba469a175e1":
    "Bảng Wood Flooring Options: mã W32 là gỗ Maple, W51 là Oak, W76 là Pine và W94 là Ash.",
  "39bd3bc904705664fcb952c20ab06cf41156ab6a9298b8de6e51e4dc34fbb681":
    "Sơ đồ tuyến đường bốn đoạn: Section 1 nối khách sạn với ga tàu; Section 2 nối ga với thành phố; Section 3 nối thành phố với núi; Section 4 nối núi với hồ.",
  "3eb7c7b2bb9a51275266d1c4bfdd9e3a939d1c2b0d0c013cc16efbfd6b16a56c":
    "Sơ đồ cửa hàng: Office ở góc trên phải, Employee Lounge ở góc dưới trái và Order Station ở góc dưới phải; vị trí kệ 1–4 được đánh dấu quanh các khu vực này.",
  "77c18a90fa17f58dbfcdac1bde4e01d3223dfa73b49161c19865784452375ffc":
    "Bản đồ Park Pavilion: Hawthorn Street ở phía trên, Bailey Street phía dưới, Court Street bên trái và Park Street bên phải; các lối A, B, C, D nằm ở bốn phía của nhà nghỉ.",
  "6356118b7014c943c2adbd8d7c1a4635e71c8c3fb7a8d55b07e188dca2c93183":
    "Sơ đồ khán phòng có sân khấu ở phía dưới: khu ghế 3 ngay trước sân khấu, khu 1 ở giữa phía sau, khu 4 bên trái và khu 2 bên phải.",
  "2d8ba795eb029084079799a6e6e5fc39d880ccc498fd4be972f20738568bf4c7":
    "Sơ đồ hội trường: Main Stage ở phía trên; Exit ở hai bên; Info Booth góc dưới trái, Coat Room góc dưới phải, Entrance ở giữa; vị trí 1–4 nằm ở bốn góc tương ứng.",
  c50146503ff5d549d502279fde4c6c9812913412b052aff08e37f54f3909343d:
    "Bảng giá ổ cắm ngoài trời: loại 20 amp giá 40 đô-la, 30 amp giá 52 đô-la, 40 amp giá 63 đô-la và 50 amp giá 75 đô-la.",
  e8d8ed0dc1ed048db62fafd53847008f0482518b68c48f39c1e2a8ac6c5a2c97:
    "Hộp thư đến: Cloudine Li gửi Nature documentary lúc 12:45 P.M.; Elise Choi gửi Riverton promotional video lúc 1:10 P.M.; Anya Lundly gửi Training schedule lúc 2:25 P.M.; Madoka Ito gửi Location suggestions lúc 3:50 P.M.",
  f4557e3a0fbf266df06f79978db60420bec51144ed441ebc423a67f07a9623eb:
    "Trang custom-bags.com có bốn sản phẩm: Item 231 Paper–Large, Item 498 Paper–Small, Item 540 Plastic–Large và Item 762 Plastic–Small.",
  "118d9c720d1781549033c09061e5c35b2e58f2f608c6c9d952dfe0290e2e3253":
    "Bradley’s Schedule: thứ Ba kiểm tra viên đến từ 2–5 P.M.; thứ Tư họp vay ngân hàng 1–4 P.M.; thứ Năm làm sạch răng 2–4 P.M.; thứ Sáu làm dự án quán cà phê 1–4 P.M.",
  "6366394997eed9406ca39675b6e5fc594e14675ffd7c2fd953521e4cfafb5cd6":
    "Sơ đồ khu đất: ao ở góc trên trái, vườn cây ăn quả bên phải, ruộng ngô phía dưới; bốn vị trí 1–4 nằm giữa đường đi và các khu vực này.",
  "8cdfa1f8d272572e4fa512a408a36ca983deb7f6e624efb7519270a1a87323e3":
    "Bảng chuyến bay: Barcelona 9:00 A.M. trễ 40 phút; Lisbon 10:30 A.M. đúng giờ; Madrid 11:00 A.M. trễ 55 phút; Paris 11:20 A.M. trễ 25 phút.",
  "3d48dd9cda1bcf15399fcc169a6a3f49d4e90e401f59e479bd0a0674f9d09e18":
    "Sơ đồ bàn có hai tủ ngăn kéo: tủ bên trái gồm ngăn A ở trên và B ở dưới; tủ bên phải gồm ngăn C ở trên và D ở dưới.",
  a384325f91d0fb54bf65a807a6b632d0455b42f6fa5bd3f174f283e55c89f176:
    "Mặt tiền Livingstone Hardware với bốn vị trí: 1 ở đèn tường, 2 ở bảng hiệu, 3 ở cửa ra vào và 4 ở cửa sổ trưng bày.",
  "84ba32f1dc38787869dbd8fcc0a085cedd7460b911593507009e3d604f445083":
    "Sơ đồ bốn làn phục vụ: Lane 1–4 từ trái sang phải; cửa sổ ở góc dưới trái và lối ra ở góc dưới phải; người xếp hàng được vẽ tại từng làn.",
  "2ec1bd75f4207725f7c8fc4bc0387f4e333854b264c7897864759003453b4d95":
    "Sơ đồ khuôn viên: vị trí 1 là Driveway bên trái, vị trí 2 là Garden phía trên, vị trí 3 là Pond bên phải và vị trí 4 ở cạnh phải của House phía dưới.",
  db327b605e20469267e7f63bcce6ec12b5ea03679fd5b1c669af34048e60c04e:
    "Bốn sản phẩm có logo tròn: áo thun ngắn tay giá 5 đô-la, áo dài tay giá 6 đô-la, túi giá 7 đô-la và mũ giá 8 đô-la.",
};

export function graphicAltOverrideFor(filePath: string): string | null {
  const hash = path.basename(filePath, path.extname(filePath));
  return GRAPHIC_ALT_OVERRIDES[hash] ?? null;
}
