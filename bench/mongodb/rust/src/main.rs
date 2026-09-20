use std::{env, error::Error, time::Instant};

use mongodb::{
    Client,
    bson::{Bson, Document, doc},
};

fn make_document(id: i64) -> Document {
    doc! {
        "_id": Bson::Int64(id),
        "seq": Bson::Int64(id),
        "title": "todo item",
        "completed": false,
        "owner": "benchmark",
        "priority": Bson::Int32(3),
    }
}

fn append_write_concern(base_uri: &str, journal: &str) -> String {
    let separator = if base_uri.contains('?') { '&' } else { '?' };
    format!("{base_uri}{separator}w=1&journal={journal}")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 6
        || !matches!(args[1].as_str(), "insert-one" | "insert-many")
        || !matches!(args[2].as_str(), "false" | "true")
    {
        eprintln!(
            "usage: mongodb-write-benchmark <base-uri> <insert-one|insert-many> <false|true> <documents> <batch-size> <collection>"
        );
        std::process::exit(2);
    }

    let base_uri = &args[0];
    let workload = &args[1];
    let journal = &args[2];
    let documents: usize = args[3].parse()?;
    let batch_size: usize = args[4].parse()?;
    let collection_name = &args[5];
    if documents == 0 || batch_size == 0 || documents > i64::MAX as usize {
        return Err(
            "documents and batch-size must be positive and documents must fit in i64".into(),
        );
    }

    let uri = append_write_concern(base_uri, journal);
    let client = Client::with_uri_str(&uri).await?;
    let database = client.database("gea_mongodb_write_bench");
    database.run_command(doc! { "ping": 1 }).await?;

    let target = database.collection::<Document>(collection_name);
    let warmup = database.collection::<Document>(&format!("{collection_name}_warmup"));
    let _ = target.drop().await;
    let _ = warmup.drop().await;

    let values: Vec<Document> = (0..documents)
        .map(|index| make_document(index as i64))
        .collect();
    let batches: Vec<&[Document]> = values.chunks(batch_size).collect();
    let warmup_count = if workload == "insert-one" {
        documents.min(16)
    } else {
        documents.min(batch_size)
    };
    let warmup_values: Vec<Document> = (0..warmup_count)
        .map(|index| make_document(-(index as i64) - 1))
        .collect();

    if workload == "insert-one" {
        for value in &warmup_values {
            warmup.insert_one(value).await?;
        }
    } else {
        let result = warmup.insert_many(&warmup_values).await?;
        if result.inserted_ids.len() != warmup_values.len() {
            return Err(format!(
                "warmup insertMany inserted {}/{}",
                result.inserted_ids.len(),
                warmup_values.len()
            )
            .into());
        }
    }
    let _ = warmup.drop().await;

    let mut operations: usize = 0;
    let mut acknowledged_documents: usize = 0;
    let started = Instant::now();
    if workload == "insert-one" {
        for value in &values {
            target.insert_one(value).await?;
            operations += 1;
            acknowledged_documents += 1;
        }
    } else {
        for batch in &batches {
            let result = target.insert_many(*batch).await?;
            if result.inserted_ids.len() != batch.len() {
                return Err(format!(
                    "insertMany inserted {}/{}",
                    result.inserted_ids.len(),
                    batch.len()
                )
                .into());
            }
            operations += 1;
            acknowledged_documents += result.inserted_ids.len();
        }
    }
    let elapsed = started.elapsed();

    let count = target.count_documents(doc! {}).await?;
    if acknowledged_documents != documents || count != documents as u64 {
        return Err(format!(
            "inserted-count mismatch: acknowledged={acknowledged_documents} count={count} expected={documents}"
        )
        .into());
    }

    let elapsed_ns = elapsed.as_nanos();
    let elapsed_seconds = elapsed.as_secs_f64();
    println!(
        "{{\"driver\":\"rust\",\"workload\":\"{}\",\"write_concern\":\"w1-j{}\",\"documents\":{},\"operations\":{},\"batch_size\":{},\"elapsed_ns\":\"{}\",\"count\":{},\"documents_per_second\":{:.6},\"operations_per_second\":{:.6}}}",
        workload,
        journal,
        documents,
        operations,
        batch_size,
        elapsed_ns,
        count,
        documents as f64 / elapsed_seconds,
        operations as f64 / elapsed_seconds,
    );

    Ok(())
}
