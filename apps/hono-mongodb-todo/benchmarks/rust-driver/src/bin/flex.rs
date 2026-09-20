use mongodb::{
    bson::{Document, doc, oid::ObjectId},
    sync::Client,
};
use std::{env, error::Error, thread, time::Instant};

fn env_usize(name: &str, fallback: usize) -> Result<usize, Box<dyn Error>> {
    Ok(env::var(name)
        .unwrap_or_else(|_| fallback.to_string())
        .parse()?)
}

fn elapsed_ms(started_at: Instant) -> f64 {
    started_at.elapsed().as_secs_f64() * 1000.0
}

fn small_document() -> Document {
    doc! { "_id": ObjectId::new(), "title": "todo", "completed": false, "revision": 1, "payload": "0123456789abcdef".repeat(16) }
}

fn string_document() -> Document {
    doc! { "payload": "x".repeat(256 * 1024) }
}

fn array_document() -> Document {
    doc! { "values": (0..4096).collect::<Vec<i32>>() }
}

fn large_document() -> Document {
    doc! { "_id": ObjectId::new(), "payload": "x".repeat(256 * 1024), "values": (0..4096).collect::<Vec<i32>>() }
}

fn encode(document: &Document) -> Result<Vec<u8>, Box<dyn Error>> {
    let mut bytes = Vec::new();
    document.to_writer(&mut bytes)?;
    Ok(bytes)
}

fn run_bson(mode: &str, iterations: usize) -> Result<(), Box<dyn Error>> {
    let document = match mode {
        "bson-small" => small_document(),
        "bson-string-256k" => string_document(),
        "bson-array-4096" => array_document(),
        _ => return Err(format!("unknown BSON mode: {mode}").into()),
    };
    let bytes = encode(&document)?;
    let mut checksum = 0usize;
    let mut started = Instant::now();
    for _ in 0..iterations {
        checksum += encode(&document)?.len();
    }
    let encode_ms = elapsed_ms(started);
    started = Instant::now();
    for _ in 0..iterations {
        let decoded = Document::from_reader(bytes.as_slice())?;
        checksum += match mode {
            "bson-small" => decoded["revision"].as_i32().unwrap_or_default() as usize,
            "bson-string-256k" => decoded["payload"].as_str().map_or(0, str::len),
            "bson-array-4096" => decoded["values"].as_array().map_or(0, Vec::len),
            _ => unreachable!(),
        };
    }
    let decode_ms = elapsed_ms(started);
    println!(
        "FLEX_RESULT:{{\"driver\":\"rust-official\",\"mode\":\"{mode}\",\"checksum\":{checksum},\"operations\":{{\"encode\":{iterations},\"decode\":{iterations}}},\"milliseconds\":{{\"encode\":{encode_ms},\"decode\":{decode_ms}}},\"bytes\":{}}}",
        bytes.len()
    );
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let mode = env::var("BENCH_MODE").unwrap_or_else(|_| "bson-small".into());
    let iterations = env_usize("BENCH_ITERATIONS", 1000)?;
    let pool_size = env_usize("BENCH_POOL_SIZE", 4)?;
    let concurrency = env_usize("BENCH_CONCURRENCY", 64)?;
    let collection_name = env::var("BENCH_COLLECTION").unwrap_or_else(|_| "flex_rust".into());
    if mode.starts_with("bson-") {
        return run_bson(&mode, iterations);
    }
    let uri = format!(
        "mongodb://127.0.0.1:27017/?directConnection=true&retryWrites=false&minPoolSize=1&maxPoolSize={pool_size}"
    );
    let client = Client::with_uri_str(&uri)?;
    client
        .database("admin")
        .run_command(doc! { "ping": 1 })
        .run()?;
    if mode == "concurrent" {
        let started = Instant::now();
        let mut workers = Vec::new();
        for worker in 0..concurrency {
            let worker_client = client.clone();
            let count = iterations / concurrency + usize::from(worker < iterations % concurrency);
            workers.push(thread::spawn(move || -> Result<usize, String> {
                for _ in 0..count {
                    worker_client
                        .database("admin")
                        .run_command(doc! { "ping": 1 })
                        .run()
                        .map_err(|error| error.to_string())?;
                }
                Ok(count)
            }));
        }
        let mut completed = 0;
        for worker in workers {
            completed += worker.join().map_err(|_| "worker panicked")??;
        }
        let milliseconds = elapsed_ms(started);
        println!(
            "FLEX_RESULT:{{\"driver\":\"rust-official\",\"mode\":\"concurrent\",\"iterations\":{completed},\"poolSize\":{pool_size},\"concurrency\":{concurrency},\"milliseconds\":{{\"concurrentPing\":{milliseconds}}}}}"
        );
        return Ok(());
    }
    let collection = client
        .database("gea_driver_benchmark")
        .collection::<Document>(&collection_name);
    if mode == "batch" {
        let batch_size = 100;
        let mut inserted = 0;
        let mut started = Instant::now();
        while inserted < iterations {
            let count = std::cmp::min(batch_size, iterations - inserted);
            collection.insert_many((0..count).map(|_| doc! { "_id": ObjectId::new(), "group": "batch", "revision": 1, "payload": "x".repeat(256) })).run()?;
            inserted += count;
        }
        let insert_batch = elapsed_ms(started);
        started = Instant::now();
        let updated = collection
            .update_many(
                doc! { "group": "batch" },
                doc! { "$set": { "revision": 2 } },
            )
            .run()?;
        if updated.matched_count != iterations as u64 {
            return Err("bulk update count mismatch".into());
        }
        let bulk_update = elapsed_ms(started);
        println!(
            "FLEX_RESULT:{{\"driver\":\"rust-official\",\"mode\":\"batch\",\"iterations\":{iterations},\"batchSize\":100,\"milliseconds\":{{\"insertBatch\":{insert_batch},\"bulkUpdate\":{bulk_update}}}}}"
        );
        return Ok(());
    }
    let mut ids = Vec::new();
    let mut started = Instant::now();
    for _ in 0..iterations {
        let value = large_document();
        ids.push(value["_id"].as_object_id().ok_or("missing id")?);
        collection.insert_one(value).run()?;
    }
    let large_insert = elapsed_ms(started);
    started = Instant::now();
    for id in ids {
        let found = collection
            .find_one(doc! { "_id": id })
            .run()?
            .ok_or("large document missing")?;
        if found["values"].as_array().map_or(0, Vec::len) != 4096 {
            return Err("large document mismatch".into());
        }
    }
    let large_find = elapsed_ms(started);
    println!(
        "FLEX_RESULT:{{\"driver\":\"rust-official\",\"mode\":\"large\",\"iterations\":{iterations},\"documentBytes\":262144,\"arrayElements\":4096,\"milliseconds\":{{\"largeInsert\":{large_insert},\"largeFind\":{large_find}}}}}"
    );
    Ok(())
}
