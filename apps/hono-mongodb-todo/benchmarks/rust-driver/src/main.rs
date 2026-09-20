use mongodb::{
    bson::{Document, doc, oid::ObjectId},
    sync::Client,
};
use std::{env, error::Error, time::Instant};

fn object_id_for(index: usize) -> Result<ObjectId, Box<dyn Error>> {
    Ok(ObjectId::parse_str(format!(
        "000000000000000000{index:06}"
    ))?)
}

fn elapsed_ms(started_at: Instant) -> f64 {
    started_at.elapsed().as_secs_f64() * 1000.0
}

fn main() -> Result<(), Box<dyn Error>> {
    let iterations = env::var("BENCH_ITERATIONS")
        .unwrap_or_else(|_| "1000".into())
        .parse::<usize>()?;
    let warmup = env::var("BENCH_WARMUP")
        .unwrap_or_else(|_| "50".into())
        .parse::<usize>()?;
    let collection_name = env::var("BENCH_COLLECTION").unwrap_or_else(|_| "driver_rust".into());
    let payload = "0123456789abcdef".repeat(16);
    let client = Client::with_uri_str(
        "mongodb://127.0.0.1:27017/?directConnection=true&retryWrites=false&maxPoolSize=1&minPoolSize=1",
    )?;
    let collection = client
        .database("gea_driver_benchmark")
        .collection::<Document>(&collection_name);
    let ids = (0..iterations)
        .map(|index| object_id_for(index + 1000))
        .collect::<Result<Vec<_>, _>>()?;
    let documents = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            doc! {
                "_id": id,
                "title": format!("todo-{index}"),
                "completed": false,
                "revision": 1,
                "payload": &payload,
            }
        })
        .collect::<Vec<_>>();

    client
        .database("admin")
        .run_command(doc! { "ping": 1 })
        .run()?;
    for index in 0..warmup {
        let id = object_id_for(index)?;
        collection.delete_one(doc! { "_id": id }).run()?;
        collection
            .insert_one(doc! {
                "_id": id, "title": "warmup", "completed": false, "revision": 1, "payload": &payload
            })
            .run()?;
        collection.find_one(doc! { "_id": id }).run()?;
        collection
            .update_one(
                doc! { "_id": id },
                doc! { "$set": { "completed": true, "revision": 2 } },
            )
            .run()?;
        collection.delete_one(doc! { "_id": id }).run()?;
    }
    let started_at = Instant::now();
    for document in &documents {
        collection.insert_one(document).run()?;
    }
    let insert_ms = elapsed_ms(started_at);

    let started_at = Instant::now();
    for id in &ids {
        if collection.find_one(doc! { "_id": id }).run()?.is_none() {
            return Err("findOne missed a seeded document".into());
        }
    }
    let find_ms = elapsed_ms(started_at);

    let started_at = Instant::now();
    for id in &ids {
        let result = collection
            .update_one(
                doc! { "_id": id },
                doc! { "$set": { "completed": true, "revision": 2 } },
            )
            .run()?;
        if result.matched_count != 1 {
            return Err("updateOne missed a seeded document".into());
        }
    }
    let update_ms = elapsed_ms(started_at);

    let started_at = Instant::now();
    for id in &ids {
        let result = collection.delete_one(doc! { "_id": id }).run()?;
        if result.deleted_count != 1 {
            return Err("deleteOne missed a seeded document".into());
        }
    }
    let delete_ms = elapsed_ms(started_at);

    println!(
        "BENCH_RESULT:{{\"driver\":\"rust-official\",\"iterations\":{iterations},\"transport\":\"one warmed pooled connection\",\"milliseconds\":{{\"insertOne\":{insert_ms},\"findOne\":{find_ms},\"updateOne\":{update_ms},\"deleteOne\":{delete_ms}}}}}"
    );
    Ok(())
}
