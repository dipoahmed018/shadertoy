// Shadertoy-style: implement mainImage(out vec4 fragColor, in vec2 fragCoord)

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = uv - 0.5;
  p.x *= iResolution.x / iResolution.y;
  float a = atan(p.y, p.x);
  float r = length(p);
  float wave = 0.5 + 0.5 * sin(10.0 * r - iTime * 3.0 + 3.0 * a);
  vec3 col = vec3(0.2, 0.45, 0.95) * wave;
  col += 0.15 * vec3(sin(iTime + uv.x * 6.28), sin(iTime * 1.3 + uv.y * 6.28), 1.0);
  fragColor = vec4(col, 1.0);
}
