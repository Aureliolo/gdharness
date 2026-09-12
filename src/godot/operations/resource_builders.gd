extends RefCounted


# Create a PhysicsMaterial resource
func create_physics_material(params: Dictionary) -> Dictionary:
	var material_path = "res://" + params.get("materialPath", "")

	var material = PhysicsMaterial.new()
	material.friction = float(params.get("friction", 1.0))
	material.bounce = float(params.get("bounce", 0.0))
	material.rough = params.get("rough", false)
	material.absorbent = params.get("absorbent", false)

	var err = ResourceSaver.save(material, material_path)

	return {"success": err == OK, "path": material_path}


# Create an Environment resource
func create_environment_resource(params: Dictionary) -> Dictionary:
	var resource_path = "res://" + params.get("resourcePath", "")
	var bg_color = params.get("backgroundColor", {"r": 0.3, "g": 0.3, "b": 0.3})
	var ambient_color = params.get("ambientLightColor", {"r": 1.0, "g": 1.0, "b": 1.0})

	var env = Environment.new()

	match params.get("backgroundMode", "sky"):
		"color":
			env.background_mode = Environment.BG_COLOR
			env.background_color = Color(float(bg_color.r), float(bg_color.g), float(bg_color.b))
		"canvas":
			env.background_mode = Environment.BG_CANVAS
		_:
			env.background_mode = Environment.BG_SKY

	env.ambient_light_color = Color(float(ambient_color.r), float(ambient_color.g), float(ambient_color.b))
	env.ambient_light_energy = float(params.get("ambientLightEnergy", 1.0))
	env.glow_enabled = params.get("glowEnabled", false)
	env.volumetric_fog_enabled = params.get("fogEnabled", false)

	var err = ResourceSaver.save(env, resource_path)

	return {"success": err == OK, "path": resource_path}


# Create a Theme resource, optionally copied from an existing one
func create_theme_resource(params: Dictionary) -> Dictionary:
	var theme_path = "res://" + params.get("themePath", "")
	var base_theme_path = params.get("baseThemePath", "")

	var theme = Theme.new()

	if base_theme_path != "" and ResourceLoader.exists("res://" + base_theme_path):
		var base = load("res://" + base_theme_path) as Theme
		if base:
			theme = base.duplicate() as Theme

	var err = ResourceSaver.save(theme, theme_path)

	return {"success": err == OK, "path": theme_path}
