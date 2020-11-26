use bevy::prelude::*;

struct Position {
    x: f32,
    y: f32,
}

fn print_position_system(position: &Position) {
    println!("Pos: {}, {}", position.x, position.y);
}

struct Entity(u64);

fn hello_world() {
    println!("hello world!");
}

struct Person;
struct Name(String);

fn add_people(mut commands: Commands) {
    commands
        .spawn((Person, Name("11".to_string())))
        .spawn((Person, Name("22".to_string())));
}

fn greet_people(_p: &Person, name: &Name) {
    println!("hello {}", name.0);
}

fn main() {
    App::build()
        .add_plugins(DefaultPlugins)
        .add_startup_system(add_people.system())
        .add_system(hello_world.system())
        .add_system(greet_people.system())
        .run();
}
