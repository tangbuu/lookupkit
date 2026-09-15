/** Real (query, passage) scoring run against the int8 PhoRanker ONNX model. */
import { ensureRerankerLoaded, scoreRelevance } from '../src/rank/reranker.js';

const cases: [label: string, query: string, passage: string][] = [
  [
    'GOOD vi (direct answer + numbers)',
    'giá vàng SJC hôm nay bao nhiêu',
    'Giá vàng miếng SJC hôm nay 15/09/2026 niêm yết ở mức 146,500 nghìn đồng mua vào và 148,000 nghìn đồng bán ra, tăng 300 nghìn đồng so với hôm qua.',
  ],
  [
    'JUNK vi (nav chrome, same domain)',
    'giá vàng SJC hôm nay bao nhiêu',
    'Trang chủ Giới thiệu Sản phẩm Tin tức Tuyển dụng Liên hệ Đăng nhập Đăng ký Giỏ hàng Chính sách bảo mật Điều khoản sử dụng',
  ],
  [
    'JUNK vi (keyword-stuffed but answerless)',
    'giá vàng SJC hôm nay bao nhiêu',
    'Giá vàng, giá vàng SJC, giá vàng hôm nay, bảng giá vàng, xem giá vàng, cập nhật giá vàng, tra cứu giá vàng, giá vàng 9999, giá vàng miếng',
  ],
  [
    'OFF-TOPIC vi',
    'giá vàng SJC hôm nay bao nhiêu',
    'Dự báo thời tiết Hà Nội ngày mai có mưa rào rải rác, nhiệt độ thấp nhất 24 độ C và cao nhất 31 độ C, độ ẩm 80%.',
  ],
  [
    'GOOD vi (weather query, weather passage)',
    'thời tiết Hà Nội ngày mai thế nào',
    'Dự báo thời tiết Hà Nội ngày mai 16/09 có mưa rào rải rác, nhiệt độ thấp nhất 24 độ C, cao nhất 31 độ C, độ ẩm 80%, gió đông bắc cấp 2.',
  ],
  [
    'GOOD en',
    'what is the capital of France',
    'Paris is the capital and most populous city of France. It is located on the river Seine and has an estimated population of 2,102,650 residents.',
  ],
  [
    'JUNK en',
    'what is the capital of France',
    'Sign up for our newsletter. Accept cookies. Terms of service. Privacy policy. Contact us. All rights reserved.',
  ],
];

await ensureRerankerLoaded();
const warm = Date.now();
await scoreRelevance('warmup', 'warmup passage');
console.log(`first inference (warm) ${Date.now() - warm}ms\n`);

for (const [label, q, p] of cases) {
  const t0 = Date.now();
  const s = await scoreRelevance(q, p);
  console.log(`${s.toFixed(4)}  ${String(Date.now() - t0).padStart(4)}ms  ${label}`);
}
