extends RefCounted

# Source for the three shader types the editor addon does not carry a template for. Written as
# real shader source rather than escaped one-liners so that what would end up in a .gdshader can
# be read here.

const PARTICLES_BASIC = """shader_type particles;

uniform float spread : hint_range(0.0, 180.0) = 45.0;
uniform float initial_velocity : hint_range(0.0, 100.0) = 5.0;

void start() {
    float angle = radians(spread) * (2.0 * RANDOM.x - 1.0);
    VELOCITY = vec3(sin(angle), cos(angle), 0.0) * initial_velocity;
}

void process() {
    // Apply gravity
    VELOCITY.y -= 9.8 * DELTA;
}
"""

const SKY_BASIC = """shader_type sky;

uniform vec4 top_color : source_color = vec4(0.4, 0.6, 1.0, 1.0);
uniform vec4 bottom_color : source_color = vec4(0.8, 0.9, 1.0, 1.0);

void sky() {
    float t = clamp(EYEDIR.y * 0.5 + 0.5, 0.0, 1.0);
    COLOR = mix(bottom_color.rgb, top_color.rgb, t);
}
"""

const FOG_BASIC = """shader_type fog;

uniform vec4 fog_color : source_color = vec4(0.5, 0.6, 0.7, 1.0);
uniform float density : hint_range(0.0, 1.0) = 0.1;

void fog() {
    DENSITY = density;
    ALBEDO = fog_color.rgb;
}
"""


# Every name answers with the basic template: there is only one of each so far, and a caller
# asking for a variant that does not exist should still get a shader that compiles.
func get_particles_shader_template(_template_name: String) -> String:
	return PARTICLES_BASIC


func get_sky_shader_template(_template_name: String) -> String:
	return SKY_BASIC


func get_fog_shader_template(_template_name: String) -> String:
	return FOG_BASIC
