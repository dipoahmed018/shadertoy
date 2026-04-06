#if !defined(VIEWER_GLSL_EMBED)
precision highp float;
precision highp int;
const vec3 iResolution = vec3(1.0, 1.0, 1.0);
const float iTime = 0.0;
const float iTimeDelta = 0.0;
const int iFrame = 0;
const vec4 iMouse = vec4(0.0);
const vec4 iDate = vec4(1970.0, 1.0, 1.0, 0.0);
const float iSampleRate = 48000.0;
layout(binding = 0) uniform sampler2D iChannel0;
layout(binding = 1) uniform sampler2D iChannel1;
layout(binding = 2) uniform sampler2D iChannel2;
layout(binding = 3) uniform sampler2D iChannel3;
const vec3 iChannelResolution[4] = vec3[4](
  vec3(1.0),
  vec3(1.0),
  vec3(1.0),
  vec3(1.0)
);
const float iChannelTime[4] = float[4](0.0, 0.0, 0.0, 0.0);
#endif

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
