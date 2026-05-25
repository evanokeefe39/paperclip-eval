import http from 'k6/http';
import { check } from 'k6';

export const options = {
  iterations: 1,
  thresholds: {
    checks: ['rate==1.0'],
  },
};

export default function () {
  const res = http.post('http://localhost:8081/invoke', JSON.stringify({
    prompt: 'Write a 10,000 word essay on the history of mathematics.',
  }), { headers: { 'Content-Type': 'application/json' }, timeout: '180s' });

  check(res, {
    'returns 200 or 504 (not hang)': (r) => r.status === 200 || r.status === 504,
    'response time under 130s': (r) => r.timings.duration < 130000,
  });
}
