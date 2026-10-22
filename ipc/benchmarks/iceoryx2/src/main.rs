use iceoryx2::prelude::*;
use std::error::Error;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::time::Instant;

unsafe extern "C" { fn full_checksum(bytes: *const u8, size: usize) -> u64; }
fn pin(cpu: usize) {
    unsafe {
        assert!(cpu < libc::CPU_SETSIZE as usize);
        let mut set: libc::cpu_set_t = std::mem::zeroed();
        libc::CPU_ZERO(&mut set); libc::CPU_SET(cpu, &mut set);
        assert_eq!(libc::sched_setaffinity(0, std::mem::size_of_val(&set), &set), 0);
        assert_eq!(libc::sched_getcpu(), cpu as i32);
    }
}
fn cpu_seconds() -> f64 {
    unsafe {
        let mut t: libc::timespec = std::mem::zeroed();
        assert_eq!(libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, &mut t), 0);
        t.tv_sec as f64 + t.tv_nsec as f64 * 1e-9
    }
}
fn expected(size: usize, id: u64) -> u64 { (size as u64 - 1) * 91 + id % 251 }
fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();
    assert!(args.len() == 7 || args.len() == 8,
        "usage: benchmark iceoryx-direct|server BYTES WINDOW ROUNDS HOST_CPU WORKER_CPU [NAME]");
    let server = args[1] == "server";
    let size: usize = args[2].parse()?;
    let window: usize = args[3].parse()?;
    let rounds: u32 = args[4].parse()?;
    let host_cpu: usize = args[5].parse()?;
    let worker_cpu: usize = args[6].parse()?;
    assert!(size > 0 && size <= 1048576 && window > 0 && window <= 64 && rounds > 0);
    assert_ne!(host_cpu, worker_cpu);
    unsafe {
        libc::alarm(90);
        if server { assert_eq!(libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL), 0); }
    }
    pin(if server { worker_cpu } else { host_cpu });
    set_log_level_from_env_or(LogLevel::Error);
    let name = if server { args[7].clone() } else { format!("knitting-quick-{}", std::process::id()) };
    let node = NodeBuilder::new().create::<ipc::Service>()?;
    let capacity = window.max(32);
    let requests = node.service_builder(&format!("{name}/requests").as_str().try_into()?)
        .publish_subscribe::<[u8]>().user_header::<u64>()
        .max_publishers(1).max_subscribers(1).subscriber_max_buffer_size(capacity)
        .subscriber_max_borrowed_samples(capacity).history_size(0).enable_safe_overflow(false)
        .open_or_create()?;
    let responses = node.service_builder(&format!("{name}/responses").as_str().try_into()?)
        .publish_subscribe::<[u8]>().user_header::<u64>()
        .max_publishers(1).max_subscribers(1).subscriber_max_buffer_size(capacity)
        .subscriber_max_borrowed_samples(capacity).history_size(0).enable_safe_overflow(false)
        .open_or_create()?;
    let (tx, rx) = if server { (&responses, &requests) } else { (&requests, &responses) };
    let subscriber = rx.subscriber_builder().buffer_size(capacity).create()?;
    let publisher = tx.publisher_builder().initial_max_slice_len(if server { 16 } else { size })
        .max_loaned_samples(capacity).create()?;
    let warmup = rounds.min(1000);
    if server {
        println!("ready"); std::io::stdout().flush()?;
        let mut cpu_start = 0.0;
        for round in 0..warmup + rounds {
            if round == warmup { cpu_start = cpu_seconds(); }
            for _ in 0..window {
                let sample = loop {
                    if let Some(sample) = subscriber.receive()? { break sample; }
                    std::hint::spin_loop();
                };
                let id = *sample.user_header();
                assert!(id >= round as u64 * window as u64 && id < (round as u64 + 1) * window as u64);
                assert_eq!(sample.payload().len(), size);
                let sum = unsafe { full_checksum(sample.payload().as_ptr(), size) };
                assert_eq!(sum, expected(size, id));
                drop(sample); // Retire request memory before replying, like C++.
                let mut reply = publisher.loan_slice_uninit(16)?;
                *reply.user_header_mut() = id;
                let mut bytes = [0u8; 16];
                bytes[..8].copy_from_slice(&id.to_ne_bytes());
                bytes[8..].copy_from_slice(&sum.to_ne_bytes());
                unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), reply.payload_mut().as_mut_ptr().cast(), 16); }
                let reply = unsafe { reply.assume_init() };
                assert_eq!(reply.send()?, 1, "response subscriber not connected");
            }
        }
        println!("{:.9}", cpu_seconds() - cpu_start);
        std::io::stdout().flush()?;
        // Keep the publisher alive until the client drains its final samples.
        let mut done = [0u8]; std::io::stdin().read_exact(&mut done)?;
        assert_eq!(done[0], b'D');
        return Ok(());
    }
    let mut child = Command::new(std::env::current_exe()?)
        .args(["server", &args[2], &args[3], &args[4], &args[5], &args[6], &name])
        .stdout(Stdio::piped()).stdin(Stdio::piped()).spawn()?;
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new(); output.read_line(&mut line)?; assert_eq!(line.trim(), "ready");
    let mut samples = Vec::with_capacity(rounds as usize);
    let mut start = Instant::now();
    let mut cpu_start = 0.0;
    for round in 0..warmup + rounds {
        if round == warmup { cpu_start = cpu_seconds(); start = Instant::now(); }
        let batch_start = Instant::now();
        for i in 0..window {
            let id = round as u64 * window as u64 + i as u64;
            let mut sample = publisher.loan_slice_uninit(size)?;
            *sample.user_header_mut() = id;
            // Initialize all bytes before assume_init; equivalent to C++ memset.
            unsafe {
                let pointer: *mut u8 = sample.payload_mut().as_mut_ptr().cast();
                std::ptr::write_bytes(pointer, 91, size); pointer.write((id % 251) as u8);
            }
            let sample = unsafe { sample.assume_init() };
            assert_eq!(sample.send()?, 1, "request subscriber not connected");
        }
        let mut seen = [false; 64];
        for _ in 0..window {
            let sample = loop {
                if let Some(sample) = subscriber.receive()? { break sample; }
                std::hint::spin_loop();
            };
            let bytes = sample.payload(); assert_eq!(bytes.len(), 16);
            let id = u64::from_ne_bytes(bytes[..8].try_into()?);
            let sum = u64::from_ne_bytes(bytes[8..].try_into()?);
            assert_eq!(*sample.user_header(), id);
            let first = round as u64 * window as u64;
            assert!(id >= first && id < first + window as u64);
            let index = (id - first) as usize;
            assert!(!seen[index]); seen[index] = true;
            assert_eq!(sum, expected(size, id));
            drop(sample);
        }
        if round >= warmup { samples.push(batch_start.elapsed().as_secs_f64() * 1e6); }
    }
    let elapsed = start.elapsed().as_secs_f64();
    let host_cpu = cpu_seconds() - cpu_start;
    child.stdin.take().unwrap().write_all(b"D")?;
    line.clear(); output.read_line(&mut line)?;
    let worker_cpu: f64 = line.trim().parse()?;
    assert!(child.wait()?.success());
    samples.sort_by(f64::total_cmp);
    let calls = rounds as u64 * window as u64;
    let p50 = samples[(samples.len() as f64 * 0.5) as usize];
    let p99 = samples[(samples.len() as f64 * 0.99) as usize];
    println!("{{\"mode\":\"iceoryx-direct\",\"bytes\":{size},\"window\":{window},\"rounds\":{rounds},\"seconds\":{elapsed},\"calls_per_second\":{},\"batch_p50_us\":{p50},\"batch_p99_us\":{p99},\"cpu_us_per_call\":{},\"host_cpu_seconds\":{host_cpu},\"worker_cpu_seconds\":{worker_cpu},\"validated_calls\":{calls}}}", calls as f64 / elapsed, (host_cpu + worker_cpu) * 1e6 / calls as f64);
    Ok(())
}
